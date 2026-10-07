/**
 * live-sink —— ⑥ 异步写入链接线（阶段一最后一根线）
 *
 * 干什么：
 *   订阅宿主 `session/event`，在一轮**真正结束**时（`turn/end`）把这一轮
 *   （首个真实用户消息 ＋ 最后一个含可见文本的回答）投影出来，调一次抽取模型，
 *   写进 `<workspace>/.dsh-semantic/turns.db` —— 让轮次记忆随真实对话增长，
 *   而不是靠事后跑回填脚本。
 *
 * 三条边界（不许越）：
 *  1. **fail-open**：任何异常都只记录并隔离该轮，绝不影响前台对话。
 *     观察者本身不干重活 —— 只判类型、取序号，重活丢进 microtask ＋ 串行队列。
 *  2. **只写自己的库**：`.dsh-semantic/turns.db`；不碰 DSH 任何数据、不碰 meow-memory。
 *  3. **幂等**：轮次 id 由 (sessionId, userSeq, answerSeq) 派生；重复触发不写第二条，
 *     也不重复花钱（先查库，命中即跳过）。
 *
 * 为什么不整体重投影事件：
 *   `turn/end` 那一刻只关心"刚结束的这一轮"。用 `session.eventAt(seq)` 从尾往前
 *   扫到上一轮起点即可（O(本轮事件数)），与回填路径共用 project.js 的
 *   hasVisibleAnswer / isRealUserTurn / projectTurn —— **同一套语义**，
 *   在线写入与离线回填不会打架。
 *
 * 宿主契约（2026-09-24 用 cordis Inspect 逐一核对，不是凭印象）：
 *   - `'session/event'(session, event)`：emit（fire-and-forget），post-commit；
 *   - `event.type === 'turn/end'` 时 `event.data = { turn, reason }`（**没有**路由信息）；
 *   - 路由只能另取：`session.requestHeader()?.config = { provider, model, reasoningEffort?, … }`；
 *   - `session.eventAt(seq)` 取单点事件；`session.snapshotEvents(from, to)` 取区间；
 *   - `ctx.llm.stream({ provider, model, messages, tools, reasoningEffort?, maxTokens? })`
 *     返回 `AsyncIterable<StreamChunk>`；**宿主字段名是驼峰 `reasoningEffort`**
 *     （snake_case 的 `reasoning_effort` 只属于直连 HTTP 的脚本）；
 *   - DeepSeek 适配器的 effort 取值是 off/low/high/max（没有 minimal），
 *     所以默认**沿用会话自身的 effort**，避免"模型不支持"被拒。
 */
import { openTurnsDb } from './schema.js'
import {
  upsertTurn, replaceTriples, saveTurnVector, getRecentTurnsBefore, getTurn, turnIdOf,
} from './store.js'
import { buildExtractMessages, EXTRACTION_TOOL } from './extract-contract.js'
import { runExtraction } from './extract-runner.js'
import { embedTexts } from './embed.js'
import { isRealUserTurn, hasVisibleAnswer, projectTurn } from './project.js'
import { redactSecrets } from './redact.js'
import { injectionSource } from '../source-kind.js'

const PLUGIN = 'dsh-memory-semantic'
const DEFAULT_MAX_TOKENS = 4000
const DEFAULT_PRIOR_TURNS = 3
const DEFAULT_CONCURRENCY = 2

/* ── 配置 ──────────────────────────────────────────────────────────── */

/**
 * 归一化配置。整块默认开启（与 sessionRelay 同一约定），`turns.live.enabled=false` 可关。
 * 关掉之后插件仍提供 memory_semantic / memory_graph，只是不再自动入库新轮次。
 */
export function normalizeLiveConfig(config) {
  const turns = config && typeof config === 'object' ? config.turns : null
  const raw = turns && typeof turns === 'object' ? turns.live : null
  const cfg = raw && typeof raw === 'object' ? raw : {}
  if (cfg.enabled === false) return null
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  }
  return {
    provider: typeof cfg.provider === 'string' && cfg.provider.trim() ? cfg.provider.trim() : null,
    model: typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null,
    reasoningEffort: typeof cfg.reasoningEffort === 'string' && cfg.reasoningEffort.trim() ? cfg.reasoningEffort.trim() : null,
    maxTokens: num(cfg.maxTokens, DEFAULT_MAX_TOKENS, 256, 32000),
    priorTurns: num(cfg.priorTurns, DEFAULT_PRIOR_TURNS, 0, 10),
    concurrency: num(cfg.concurrency, DEFAULT_CONCURRENCY, 1, 8),
    vector: cfg.vector !== false,
    // 与回填脚本同口径：只处理 `session-` 前缀的主会话，子代理会话不入轮次库。
    mainSessionsOnly: cfg.mainSessionsOnly !== false,
  }
}

/* ── 纯逻辑：定位"刚结束的这一轮" ─────────────────────────────────── */

/**
 * 从 turn/end 的 seq 往前扫，定位本轮端点。
 *
 * 规则（与 project.collectTurnEndpoints 同语义）：
 *  - 先遇到 `hasVisibleAnswer` 的 assistant/message → 它就是本轮回答（多个则取最靠近末尾的）；
 *  - 继续往前，遇到 `isRealUserTurn` 的 user/message → 本轮起点；
 *  - 在找到回答**之前**先遇到真实用户消息 = 本轮没有可见回答 → 返回 null（不抽）；
 *  - 遇到 !event（seq 不存在）→ 停止（防越出日志头）。
 *
 * @param getEvent (seq) => event|undefined
 * @param endSeqExclusive turn/end 自身的 seq（不含）
 * @param floorSeq 上一条已处理 turn/end 的 seq（含；它之前的都属于上一轮，别越界）
 * @returns { userSeq, answerSeq } —— 任一为 null 表示这一轮没有可抽取的东西
 */
export function locateTurn(getEvent, endSeqExclusive, floorSeq) {
  const end = Number(endSeqExclusive)
  const floor = Number.isFinite(Number(floorSeq)) ? Math.max(0, Number(floorSeq)) : 0
  let answerSeq = null
  for (let seq = end - 1; seq >= floor; seq -= 1) {
    const event = getEvent(seq)
    if (!event) break
    if (answerSeq === null) {
      if (hasVisibleAnswer(event)) { answerSeq = seq; continue }
      if (isRealUserTurn(event)) return { userSeq: null, answerSeq: null }
      continue
    }
    if (isRealUserTurn(event)) return { userSeq: seq, answerSeq }
  }
  return { userSeq: null, answerSeq }
}

/** 该会话下一个 turn_index：接着库里已有编号往下排（与回填的编号体系天然衔接）。 */
export function nextTurnIndex(db, sessionId) {
  const row = db.prepare('SELECT COALESCE(MAX(turn_index), -1) AS m FROM tm_turns WHERE session_id=?').get(String(sessionId))
  const max = Number(row?.m ?? -1)
  return (Number.isFinite(max) ? max : -1) + 1
}

/** 路由：配置优先，否则用会话自己的 header（一定是该模型支持的组合）。 */
export function resolveRoute(session, cfg) {
  let header
  try { header = session?.requestHeader?.() } catch { header = undefined }
  const config = header?.config ?? {}
  const provider = cfg.provider || (typeof config.provider === 'string' ? config.provider : '')
  const model = cfg.model || (typeof config.model === 'string' ? config.model : '')
  if (!provider || !model) return null
  const reasoningEffort = cfg.reasoningEffort || (typeof config.reasoningEffort === 'string' && config.reasoningEffort ? config.reasoningEffort : null)
  return { provider, model, reasoningEffort }
}

/**
 * 用宿主的模型能力**协商**一次调用的路由与档位（2026-10-07 新增）。
 *
 * 为什么需要：`resolveRoute` 只是"取一个 provider/model/effort 组合"，而这个组合
 * **不一定被目标模型支持** —— 典型场景是我们配了独立抽取模型（`turns.live.model`），
 * 却沿用了会话自身的 reasoningEffort，而那个档位在新模型上不存在 → 请求直接被拒
 * （上游 graph-memory beta.17 的 #117 踩的就是这个）。
 *
 * 官方 `ctx.llm.resolveCallConfig()` 专干这件事：按适配器能力校验、必要时物化默认值，
 * "不支持的显式 effort **在发出请求前**就 reject"。所以策略是：
 *   ① 先让它校验 → ② 被拒就去掉 explicit effort 再协商一次（适配器给自己的默认档，
 *   而不是我们瞎猜）→ ③ 仍失败就照原样发，交给上层 fail-open 隔离该轮
 *   （绝不因为"协商失败"就丢掉这一轮记忆）。
 */
export async function negotiateCallConfig(llm, base, log = () => {}) {
  if (!llm || typeof llm.resolveCallConfig !== 'function') return base
  try {
    const resolved = await llm.resolveCallConfig(base)
    return resolved && typeof resolved === 'object' ? { ...base, ...resolved } : base
  } catch (error) {
    if (!base.reasoningEffort) {
      log('warn', `live sink 路由协商失败（沿用原配置）：${(error && error.message) || error}`)
      return base
    }
    const { reasoningEffort, ...rest } = base
    log('warn', `live sink 档位 ${reasoningEffort} 不被 ${base.provider}/${base.model} 支持，改用适配器默认档`)
    try {
      const resolved = await llm.resolveCallConfig(rest)
      return resolved && typeof resolved === 'object' ? { ...rest, ...resolved } : rest
    } catch (e2) {
      log('warn', `live sink 去掉档位后协商仍失败（沿用原配置）：${(e2 && e2.message) || e2}`)
      return base
    }
  }
}

/* ── 宿主消息构造 ──────────────────────────────────────────────────── */

let factoriesPromise = null
function loadFactories() {
  if (!factoriesPromise) {
    factoriesPromise = import('@deepseek-ai/dsh-llm')
      .then((m) => ({
        system: typeof m.createSystemMessage === 'function' ? m.createSystemMessage : null,
        user: typeof m.createUserMessage === 'function' ? m.createUserMessage : null,
      }))
      .catch(() => null)
  }
  return factoriesPromise
}

/**
 * 把 buildExtractMessages 的朴素 `{role, content}` 转成宿主 Message。
 * 工厂不可用时退化成手搓最小形态（role/content/source/id 齐全），保证不因 import 失败而整条线失效。
 */
export async function toHostMessages(simple = []) {
  const factories = await loadFactories()
  const stamp = Date.now().toString(36)
  // 注入 source 按宿主会话格式自适应（v3 / v4），整批共用一个基础对象
  const srcInput = await injectionSource(PLUGIN, '轮次抽取输入')
  const srcSystem = await injectionSource(PLUGIN, '轮次抽取系统提示')
  return simple.map((message, index) => {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user'
    const content = [{ type: 'text', text: String(message?.content ?? '') }]
    if (role === 'system' && factories?.system) {
      try { return factories.system(String(message?.content ?? ''), PLUGIN) } catch { /* 落到手搓形态 */ }
    }
    if (role === 'user' && factories?.user) {
      try {
        return factories.user({ content, source: { ...srcInput } })
      } catch { /* 落到手搓形态 */ }
    }
    return {
      id: `mse-${stamp}-${index}`,
      role,
      content,
      source: { ...(role === 'system' ? srcSystem : srcInput) },
    }
  })
}

/* ── 运行时 ────────────────────────────────────────────────────────── */

export function createSinkRuntime({ llm, cfg, logger, openDb = openTurnsDb, embed = embedTexts }) {
  const dbs = new Map() // workspace → db
  const watermarks = new Map() // sessionId → 上一条已处理 turn/end 的 seq
  const chains = new Map() // sessionId → Promise（每会话一条串行链）
  let active = 0
  const waiting = []
  const log = (level, text) => {
    // 双写：console 进启动器的 launcher.out.log（唯一我能读到的通道），logger 走宿主
    try { console.log(`[${PLUGIN}] ${text}`) } catch { /* 没有控制台 */ }
    try { logger && typeof logger[level] === 'function' && logger[level](`${PLUGIN}: ${text}`) } catch { /* 日志失败不影响 */ }
  }

  function dbOf(workspace) {
    let db = dbs.get(workspace)
    if (!db) { db = openDb(workspace); dbs.set(workspace, db) }
    return db
  }

  /** 全局并发闸门：多会话同时结束轮次时，最多 cfg.concurrency 个抽取在跑。 */
  async function withGate(fn) {
    if (active >= cfg.concurrency) await new Promise((resolve) => waiting.push(resolve))
    active += 1
    try { return await fn() } finally {
      active -= 1
      const next = waiting.shift()
      if (next) next()
    }
  }

  /** 事件入口：只做极轻的筛选，重活交给微任务链。 */
  function onSessionEvent(session, event) {
    try {
      if (!event || event.type !== 'turn/end') return
      const header = session?.header
      const sid = String(header?.id ?? '')
      if (!sid) return
      if (cfg.mainSessionsOnly && !sid.startsWith('session-')) return
      if (String(header?.origin ?? '') === 'subagent') return
      if (!header?.cwd) return
      const prev = chains.get(sid) ?? Promise.resolve()
      const next = prev
        .then(() => handle(session, event))
        .catch((error) => { log('warn', `live sink 失败（已忽略）：${(error && error.message) || error}`) })
      chains.set(sid, next)
      next.then(() => { if (chains.get(sid) === next) chains.delete(sid) })
    } catch (error) {
      log('warn', `live sink 入口异常（已忽略）：${(error && error.message) || error}`)
    }
  }

  async function handle(session, event) {
    const header = session?.header ?? {}
    const sid = String(header.id ?? '')
    const workspace = header.cwd
    const endSeq = Number(event?.seq)
    if (!sid || !workspace || !Number.isInteger(endSeq) || endSeq < 1) return

    // 水位 = 上一条已处理的 turn/end 的 seq：
    //  - 它既是"这条已经处理过了"的判据（同一个 turn/end 不会重放），
    //  - 也是本轮向前扫描的下界（本轮起点一定在它之后）。
    // 本轮无论抽成没抽成、有没有东西可抽，水位都推到本条 turn/end ——
    // 失败轮由回填脚本兜底，绝不在前台反复重试（那是花钱的死循环）。
    const floor = watermarks.get(sid) ?? 0
    if (endSeq <= floor) return
    watermarks.set(sid, endSeq)

    const cache = new Map() // 本轮向前扫描只查一次同一点
    const getEvent = (seq) => {
      if (!cache.has(seq)) {
        const hit = session.eventAt(seq)
        cache.set(seq, hit === undefined || hit === null ? null : hit)
      }
      return cache.get(seq) ?? undefined
    }
    const located = locateTurn(getEvent, endSeq, floor)

    if (located.userSeq === null || located.answerSeq === null) return
    const { userSeq, answerSeq } = located

    const db = dbOf(workspace)
    if (getTurn(db, turnIdOf(sid, [userSeq, answerSeq]))) return // 幂等：这轮已在库里

    const stub = {}
    stub[userSeq] = session.eventAt(userSeq)
    stub[answerSeq] = session.eventAt(answerSeq)
    const turnIndex = nextTurnIndex(db, sid)
    let projected
    try {
      projected = projectTurn(stub, userSeq, answerSeq, { sessionId: sid, turnIndex })
    } catch (error) {
      log('warn', `live sink 投影失败（隔离该轮）：${(error && error.message) || error}`)
      return
    }
    if (!projected) return

    const route = resolveRoute(session, cfg)
    if (!route) { log('warn', 'live sink 拿不到 provider/model，跳过该轮'); return }
    // 用宿主能力协商一次：不支持的档位在发出请求前就被挡下，改走适配器默认档
    const callCfg = await negotiateCallConfig(llm, { ...route, maxTokens: cfg.maxTokens }, log)

    const prior = cfg.priorTurns > 0
      ? getRecentTurnsBefore(db, sid, turnIndex, cfg.priorTurns).map((turn) => redactSecrets(turn.summary))
      : []
    // 闸门（2026-10-06）：投影文本在送抽取模型之前先脱敏。
    // store.upsertTurn 里那道只挡"落库"，挡不住"明文被送到模型 API"；两道都过（幂等）。
    const userText = redactSecrets(projected.userText)
    const answerText = redactSecrets(projected.answerText)
    const messages = buildExtractMessages({
      userText,
      answerText,
      priorSummaries: prior,
    })
    const hostMessages = await toHostMessages(messages)
    const started = Date.now()
    const outcome = await withGate(() => runExtraction({
      messages,
      stream: () => llm.stream({
        provider: callCfg.provider,
        model: callCfg.model,
        messages: hostMessages,
        tools: [EXTRACTION_TOOL],
        maxTokens: callCfg.maxTokens ?? cfg.maxTokens,
        ...(!callCfg.reasoningEffort ? {} : { reasoningEffort: callCfg.reasoningEffort }),
      }),
    }))

    if (!outcome.ok) {
      log('warn', `live sink 抽取失败（已隔离该轮 ${sid.slice(0, 12)}#${turnIndex}）：${outcome.error}`)
      return
    }

    const record = upsertTurn(db, {
      sessionId: sid,
      turnIndex,
      summary: outcome.result.summary,
      outcome: outcome.result.outcome,
      userSeq,
      answerSeq,
      userText,
      answerText,
    })
    replaceTriples(db, record.id, sid, outcome.result.triples)

    if (cfg.vector) {
      try {
        const [vector] = await embed([outcome.result.summary])
        if (Array.isArray(vector) && vector.length) saveTurnVector(db, record.id, outcome.result.summary, vector)
      } catch { /* 向量失败只影响语义召回，词法路径不受影响 */ }
    }

    const usage = outcome.usage ?? {}
    log('info', `live sink 入库 ${sid.slice(0, 12)}#${turnIndex} [${outcome.result.outcome}·${outcome.via}] `
      + `${((Date.now() - started) / 1000).toFixed(1)}s 输入 ${usage.inputTokens ?? usage.prompt_tokens ?? '-'} 输出 ${usage.outputTokens ?? usage.completion_tokens ?? '-'}`)
  }

  /** 供自测/诊断：当前水位与排队情况（只读快照）。 */
  function state() {
    return {
      watermarks: Object.fromEntries(watermarks),
      chains: [...chains.keys()].map((sid) => sid.slice(0, 12)),
      active,
      waiting: waiting.length,
      dbs: [...dbs.keys()],
    }
  }

  /** 释放：关掉自己打开的库连接（插件卸载时调用）。 */
  function dispose() {
    for (const db of dbs.values()) { try { db.close() } catch { /* 已关 */ } }
    dbs.clear()
  }

  return { onSessionEvent, state, dispose, handle }
}

/* ── 注册 ──────────────────────────────────────────────────────────── */

/**
 * 注册结果必须**可观测**：`ctx.logger` 不落任何可读文件（2026-09-24 实测），
 * 只写 logger 会让"没生效"和"没加载"在外部完全同形。所以同时打一行 console
 * （会进启动器的 launcher.out.log），并把降级原因说清。
 */
export function announce(logger, text) {
  try { console.log(`[${PLUGIN}] ${text}`) } catch { /* 没有控制台 */ }
  try { logger && typeof logger.info === 'function' && logger.info(`${PLUGIN}: ${text}`) } catch { /* 日志失败不影响 */ }
}

/**
 * 注册异步写入链接线。依赖由 index.js 注入（与 session-relay 同一范式）。
 * @param ctx Cordis 上下文
 * @param deps {{ logger, config }}
 */
export function registerLiveSink(ctx, deps) {
  const { logger, config } = deps
  const cfg = normalizeLiveConfig(config)
  if (!cfg) {
    announce(logger, 'live sink off（turns.live.enabled=false）')
    return null
  }
  const llm = ctx.get('llm')
  if (!llm) {
    announce(logger, 'live sink OFF —— 拿不到 llm 服务（应改成 inject 硬依赖）')
    return null
  }
  const runtime = createSinkRuntime({ llm, cfg, logger })
  ctx.effect(() => {
    const off = ctx.on('session/event', runtime.onSessionEvent)
    return () => {
      try { typeof off === 'function' && off() } catch { /* 宿主自会清理 */ }
      runtime.dispose()
    }
  }, 'dsh-memory-semantic: live sink (turn/end → turns.db)')
  announce(logger, `live sink on（turn/end → turns.db，并发 ${cfg.concurrency}，maxTokens ${cfg.maxTokens}）`)
  return runtime
}
