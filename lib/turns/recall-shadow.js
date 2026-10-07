/**
 * recall-shadow —— 上下文组装接线（③，第一阶段＝**旁路**：只记录、不注入）
 *
 * 干什么：
 *   在每一轮真正请求模型之前（`agent/pre-step`），拿"最后一条真实用户消息"当查询，
 *   去轮次记忆库里召回更早的历史原文，**组装出"如果注入会是什么样"**，写进
 *   `<workspace>/.dsh-semantic/recall-shadow.jsonl` —— 但**不修改进入模型的消息**。
 *
 * 为什么先旁路（维护者 2026-09-23 定的施工顺序）：
 *   组装与召回的质量要**先在真实对话上观察**，确认命中准、不灌水、不和 relay/meow-memory
 *   打架之后，再打开 `inject`。打开只需改配置（`turns.recallShadow.inject=true`），不用改代码。
 *
 * 三条边界：
 *  1. **旁路默认关闭注入**：`inject=false` 时返回原 decision，一个字节都不改；
 *  2. **绝不拖慢前台**：拿 evidence 只在 `next()` 之后异步做（fire-and-forget），失败只记文件不抛；
 *  3. **每轮只算一次**：同一轮的多个 step 共用同一个用户问题，按查询指纹去重。
 */
import fs from 'node:fs'
import path from 'node:path'
import { openTurnsDb, turnsDbExists } from './schema.js'
import { recallTurns, visibleKey } from './recall.js'
import { assembleRecall, buildRecallMessage, insertBeforeCurrentUser, DEFAULT_ASSEMBLY } from './assemble.js'
import { embedQuery } from './embed.js'
import { splitInjected, textOfBlocks } from './project.js'
import { redactSecrets } from './redact.js'
import { textOfMessages } from '../injection-ledger.js'

const PLUGIN = 'dsh-memory-semantic'
const SHADOW_FILE = 'recall-shadow.jsonl'

/** 归一化配置。整块默认**开启记录、关闭注入**；`turns.recallShadow.enabled=false` 可整块关。 */
export function normalizeShadowConfig(config) {
  const turns = config && typeof config === 'object' ? config.turns : null
  const raw = turns && typeof turns === 'object' ? turns.recallShadow : null
  const cfg = raw && typeof raw === 'object' ? raw : {}
  if (cfg.enabled === false) return null
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  }
  return {
    /** ⚠️ 默认 false：只记录不注入。确认无误后再打开。 */
    inject: cfg.inject === true,
    vector: cfg.vector !== false,
    k: num(cfg.k, 5, 1, 20),
    /** 当前会话最近多少轮算"已经看得见"，不重复召回 */
    visibleTurns: num(cfg.visibleTurns, 6, 0, 50),
    maxChars: num(cfg.maxChars, DEFAULT_ASSEMBLY.maxChars, 400, 20000),
    maxTurns: num(cfg.maxTurns, DEFAULT_ASSEMBLY.maxTurns, 1, 12),
    /** 查询门控：提问实义字少于这个数就不去翻历史（"继续吧"这类）。0 = 关闭门控。 */
    minQueryChars: num(cfg.minQueryChars, 4, 0, 50),
    mainSessionsOnly: cfg.mainSessionsOnly !== false,
  }
}

/** 从"即将进入这一步的消息"里取本轮真实提问（剥掉插件注入块）。 */
export function extractQuery(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]
    if (message?.source?.kind !== 'user') continue
    const { real } = splitInjected(message.content)
    const text = textOfBlocks(real).trim()
    if (text) return text
  }
  return null
}

/** 当前会话"已经看得见"的轮次 key（最近 N 轮不重复召回）。 */
export function visibleKeysOf(db, sessionId, visibleTurns) {
  const keys = new Set()
  if (visibleTurns <= 0) return keys
  const rows = db.prepare('SELECT user_seq FROM tm_turns WHERE session_id=? ORDER BY turn_index DESC LIMIT ?')
    .all(String(sessionId), visibleTurns)
  for (const row of rows) keys.add(visibleKey(String(sessionId), Number(row.user_seq)))
  return keys
}

/**
 * 跑一次召回 + 组装（不做任何注入）。纯逻辑，便于离线自测。
 * @returns { query, diagnostics, results, assembled, message }
 */
export async function planRecall({ db, sessionId, query, cfg }) {
  const excludeKeys = visibleKeysOf(db, sessionId, cfg.visibleTurns)
  const queryVector = cfg.vector ? await embedQuery(query) : null
  const { results, diagnostics } = recallTurns(db, {
    query, queryVector, k: cfg.k, excludeKeys, minQueryChars: cfg.minQueryChars,
  })
  const assembled = assembleRecall(results, { maxChars: cfg.maxChars, maxTurns: cfg.maxTurns })
  const message = assembled.text
    ? await buildRecallMessage(results, { maxChars: cfg.maxChars, maxTurns: cfg.maxTurns })
    : null
  return { query, diagnostics, results, assembled, message }
}

/* ── 记录 ──────────────────────────────────────────────────────────── */

export function shadowPathOf(workspace) {
  return path.join(workspace, '.dsh-semantic', SHADOW_FILE)
}

/** 追加一行记录（永不自动删旧行——诊断数据也不替维护者做主）。 */
export function appendShadow(workspace, record) {
  try {
    const file = shadowPathOf(workspace)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function shadowRecord({ sessionId, turn, step, plan, injected }) {
  const hits = plan.results.map((r) => ({
    turnId: r.turnId,
    sessionId: String(r.sessionId).slice(0, 24),
    turnIndex: r.turnIndex,
    score: r.score,
    routes: r.routes,
    summary: redactSecrets(String(r.summary)).slice(0, 80),
  }))
  return {
    at: Date.now(),
    sessionId: String(sessionId).slice(0, 24),
    turn,
    step,
    queryChars: plan.query.length,
    // 闸门（2026-10-06）：先脱敏再截断——反过来会把密钥截成"半个"，
    // 半个密钥照样是泄露（2026-10-06 在会话日志里就见过 29 位的截断形态）。
    queryHead: redactSecrets(plan.query).slice(0, 100),
    diagnostics: plan.diagnostics,
    hits,
    wouldInject: Boolean(plan.message),
    injected: Boolean(injected),
    assembledChars: plan.assembled.chars,
    included: plan.assembled.included.length,
    skipped: plan.assembled.skipped.length,
    head: plan.assembled.text ? redactSecrets(plan.assembled.text).slice(0, 200) : '',
  }
}

/* ── 运行时 ────────────────────────────────────────────────────────── */

export function createShadowRuntime({ cfg, logger, ledger = null, openDb = openTurnsDb }) {
  const dbs = new Map()
  const lastQuery = new Map() // sessionId → 本轮查询指纹（同轮多 step 只算一次）
  const log = (level, text) => {
    // 双写：console 进启动器的 launcher.out.log（`ctx.logger` 不落任何可读文件）
    try { console.log(`[${PLUGIN}] ${text}`) } catch { /* 没有控制台 */ }
    try { logger && typeof logger[level] === 'function' && logger[level](`${PLUGIN}: ${text}`) } catch { /* 日志失败不影响 */ }
  }

  function dbOf(workspace) {
    let db = dbs.get(workspace)
    if (!db) { db = openDb(workspace); dbs.set(workspace, db) }
    return db
  }

  /** 异步、绝不阻塞：拿到 evidence 后写一行 shadow。 */
  async function observe(agent, messages, turn, step) {
    const header = agent?.session?.header ?? {}
    const sid = String(header.id ?? '')
    const workspace = header.cwd
    if (!sid || !workspace) return
    if (cfg.mainSessionsOnly && !sid.startsWith('session-')) return
    if (String(header.origin ?? '') === 'subagent') return
    const query = extractQuery(messages)
    if (!query) return
    const fingerprint = `${query.length}:${query.slice(0, 40)}`
    if (lastQuery.get(sid) === fingerprint) return
    lastQuery.set(sid, fingerprint)
    if (!turnsDbExists(workspace)) return

    const db = dbOf(workspace)
    const plan = await planRecall({ db, sessionId: sid, query, cfg })
    // inject=true 时才由调用方真正插入；这里只记录"如果注入会怎样"
    const injected = false
    appendShadow(workspace, shadowRecord({ sessionId: sid, turn, step, plan, injected }))
    if (plan.message) {
      log('info', `recall shadow ${sid.slice(0, 12)} 命中 ${plan.results.length} 轮 / 若注入 ${plan.assembled.chars} 字符（inject=${cfg.inject}）`)
    }
    return plan
  }

  /** 真正注入（只有 inject=true 才走到这里）。 */
  async function injectInto(agent, messages, turn, step) {
    const header = agent?.session?.header ?? {}
    const sid = String(header.id ?? '')
    const workspace = header.cwd
    const query = extractQuery(messages)
    if (!sid || !workspace || !query) return { messages, inserted: false }
    if (cfg.mainSessionsOnly && !sid.startsWith('session-')) return { messages, inserted: false }
    if (!turnsDbExists(workspace)) return { messages, inserted: false }
    const plan = await planRecall({ db: dbOf(workspace), sessionId: sid, query, cfg })
    appendShadow(workspace, shadowRecord({ sessionId: sid, turn, step, plan, injected: Boolean(plan.message) }))
    if (!plan.message) return { messages, inserted: false }
    const out = insertBeforeCurrentUser(messages, plan.message)
    if (out.inserted) log('info', `${PLUGIN}: 召回注入 ${plan.assembled.chars} 字符（${plan.assembled.included.length} 轮）`)
    return out
  }

  /**
   * pre-step 入口：waterfall。旁路模式下**原样返回 next() 的 decision**。
   */
  async function onPreStep(payload, next) {
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'enter') return decision
      if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision
      if (payload?.signal?.aborted) return decision
      // 去重登记（2026-10-07）：把"已经在上下文里的记忆 id"记下来 ——
      // 包括 meow-memory 注入的那些（我们只读消息文本，不碰它的数据）。
      // 登记之后，动作触发与召回就不会把同一条再塞一遍。
      if (ledger) {
        try {
          ledger.observeText(String(payload?.agent?.session?.header?.id ?? ''), textOfMessages(decision.messages))
        } catch { /* 登记失败不影响注入 */ }
      }
      if (!cfg.inject) {
        // 旁路：只观察最终会进模型的那批消息，不 await（绝不拖慢前台）
        observe(payload?.agent, decision.messages, payload?.turn, payload?.step).catch((error) => {
          log('warn', `recall shadow 记录失败：${(error && error.message) || error}`)
        })
        return decision
      }
      const out = await injectInto(payload?.agent, decision.messages, payload?.turn, payload?.step)
      return out.inserted ? { ...decision, messages: out.messages } : decision
    } catch (error) {
      log('warn', `recall shadow 异常（已忽略）：${(error && error.message) || error}`)
      return decision
    }
  }

  function dispose() {
    for (const db of dbs.values()) { try { db.close() } catch { /* 已关 */ } }
    dbs.clear()
  }

  return { onPreStep, observe, injectInto, dispose, state: () => ({ dbs: [...dbs.keys()], tracked: [...lastQuery.keys()].length }) }
}

/** 注册上下文组装接线（③）。依赖由 index.js 注入，与 relay / live-sink 同范式。 */
export function registerRecallShadow(ctx, deps) {
  const { logger, config, ledger = null } = deps
  const cfg = normalizeShadowConfig(config)
  const announce = (text) => {
    try { console.log(`[${PLUGIN}] ${text}`) } catch { /* 没有控制台 */ }
    try { logger && typeof logger.info === 'function' && logger.info(`${PLUGIN}: ${text}`) } catch { /* 忽略 */ }
  }
  if (!cfg) {
    announce('recall shadow off（turns.recallShadow.enabled=false）')
    return null
  }
  const runtime = createShadowRuntime({ cfg, logger, ledger })
  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', runtime.onPreStep)
    return () => {
      try { typeof off === 'function' && off() } catch { /* 宿主自会清理 */ }
      runtime.dispose()
    }
  }, 'dsh-memory-semantic: recall shadow (agent/pre-step)')
  announce(`recall shadow on（inject=${cfg.inject ? 'true' : 'false（只记录）'}，k=${cfg.k}，可见轮 ${cfg.visibleTurns}）`)
  return runtime
}
