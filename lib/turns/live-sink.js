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
  enqueueExtraction, markExtraction, setSessionWatermark, listDueExtractions,
} from './store.js'
import { buildExtractMessages, EXTRACTION_TOOL } from './extract-contract.js'
import { runExtraction } from './extract-runner.js'
import { embedTexts } from './embed.js'
import { LlmFailureGuard } from './llm-guard.js'
import { loadCompletedTurns, pickTurns } from './backfill-core.js'
import { isRealUserTurn, hasVisibleAnswer, projectTurn } from './project.js'
import { redactSecrets } from './redact.js'
import { injectionSource } from '../source-kind.js'

const PLUGIN = 'dsh-memory-semantic'
const DEFAULT_MAX_TOKENS = 4000
const DEFAULT_PRIOR_TURNS = 3
const DEFAULT_CONCURRENCY = 2

/**
 * 抽取默认思考档位（2026-10-08 实测后定）。
 *
 * 为什么固定成一个温和档、而不是沿用会话自身的档位：
 *   **抽取是结构化小任务**（把一轮对话压成摘要 + 几组三元组），不需要深度思考。
 *   实测（2026-10-08）：会话开着 max 档时，`maxTokens: 4000` 的预算被思考吃光，
 *   模型连正文都没吐出来就被截断（`finish_reason: max-tokens`）→ 那一轮抽取失败，
 *   **这一轮的记忆压根没长出来**。而缺一轮记忆的代价，比"少花点思考"大得多。
 *
 * 取值说明：DeepSeek 适配器的档位是 off/low/high/max；low 普遍被支持，
 * 万一某个适配器不支持，`negotiateCallConfig` 会在发请求前拦下并回落到适配器默认档。
 * 用户在 config 里显式配了 `turns.live.reasoningEffort` 时，以配置为准。
 */
const DEFAULT_EXTRACT_EFFORT = 'low'

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
  // LLM 守卫（对齐上游 llm-guard）：凭证/端点类错误（401/403/404）拉闸冷却，
  // 免得在注定失败的配置下每轮都白试一次、白花一次钱；429/5xx 与 400/422 不拉闸。
  const guard = new LlmFailureGuard(cfg.guardCooldownMs)
  const chains = new Map() // sessionId → Promise（每会话一条串行链）
  const recoveredWorkspaces = new Set() // 已经跑过启动恢复的工作区（每区只跑一次）
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
      // 启动恢复搭车：每个工作区只跑一次，丢进微任务不阻塞当前轮（对齐上游"重启后继续抽"）。
      const ws = String(header.cwd)
      if (!recoveredWorkspaces.has(ws)) {
        recoveredWorkspaces.add(ws)
        queueMicrotask(() => { recoverDue(ws).catch(() => {}) })
      }
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

  /**
   * 抽取一轮并落库 —— **在线写入与启动恢复共用这一段**。
   *
   * 抽出来是为了让 recoverDue 复用同一套语义（脱敏／守卫／协商／写库／水位），
   * 而不是在恢复路径里重写一份。差异只在两处：`origin` 只影响日志措辞；
   * `route` 在线来自 session、恢复来自队列表（v5 记下的那几个列）。
   *
   * @returns {Promise<boolean>} 是否成功落库（失败/暂停/超时一律 false，但都在队列里留了状态）
   */
  async function processTurn({ db, sid, workspace, turnIndex, userSeq, answerSeq, userText: rawUser, answerText: rawAnswer, route, queueKey, origin }) {
    if (!guard.canRun()) {
      // 冷却中：不发起请求，但**把这一轮留在队列里**（登记已经做过），
      // 等冷却结束或人工修好配置后，下一次启动恢复会把它捡起来。
      log('warn', `live sink 暂停中（${guard.remainingText()}），本轮留在队列：${sid.slice(0, 12)}#${turnIndex}`)
      return false
    }

    // 用宿主能力协商一次：不支持的档位在发出请求前就被挡下，改走适配器默认档
    // 覆盖档位：抽取用 DEFAULT_EXTRACT_EFFORT，不沿用会话自身（见该常量处的实测说明）；
    // 用户显式配了 turns.live.reasoningEffort 就以配置为准。
    const extractEffort = cfg.reasoningEffort ?? DEFAULT_EXTRACT_EFFORT
    const callCfg = await negotiateCallConfig(
      llm,
      { ...route, reasoningEffort: extractEffort, maxTokens: cfg.maxTokens },
      log,
    )

    const prior = cfg.priorTurns > 0
      // 编号此时还没分配（交给 upsertTurn 原子分配），所以"本轮之前"用一个足够大的边界；
      // 语义仍是"这个会话到目前为至最新的 N 轮"，不受编号未定影响。
      ? getRecentTurnsBefore(db, sid, Number.MAX_SAFE_INTEGER, cfg.priorTurns).map((turn) => redactSecrets(turn.summary))
      : []
    // 闸门（2026-10-06）：投影文本在送抽取模型之前先脱敏。
    // store.upsertTurn 里那道只挡"落库"，挡不住"明文被送到模型 API"；两道都过（幂等）。
    const userText = redactSecrets(rawUser)
    const answerText = redactSecrets(rawAnswer)
    const messages = buildExtractMessages({ userText, answerText, priorSummaries: prior })
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
      // 失败不再是"只打一行日志就走"：写进队列，带指数退避重试，
      // 连失 maxAttempts 次转 quarantined（隔离，等回填/人工，不再自动花钱）。
      const tripped = guard.tripIfNeeded(outcome.error)
      if (tripped) {
        // 凭证/端点/模型类错误：光重试没用，拉闸等人工
        log('warn', `live sink 触发 LLM 守卫（${guard.remainingText()}）：${outcome.error}`)
      }
      const marked = markExtraction(db, queueKey, { state: 'failed', error: outcome.error })
      log('warn', `live sink 抽取失败[${origin}]（${marked.state}，第 ${marked.attempts} 次 ${sid.slice(0, 12)}#${turnIndex}）：${outcome.error}`)
      return false
    }

    // 不传 turnIndex：交给 store 的**原子分配**（在线与恢复并发也不会撞号）。
    // 返回后以 `record.turnIndex` 为准 —— 后面的水位、日志都用这个真实落库的编号，
    // 免得"我算的是 23、实际写进去的是 24"这种各算各的。
    const record = upsertTurn(db, {
      sessionId: sid,
      summary: outcome.result.summary,
      outcome: outcome.result.outcome,
      userSeq,
      answerSeq,
      userText,
      answerText,
    })
    const realIndex = Number(record.turnIndex)
    replaceTriples(db, record.id, sid, outcome.result.triples)
    markExtraction(db, queueKey, { state: 'succeeded' })
    // 会话水位（对齐上游 m12）：这个会话已完成到第几轮。
    // 上游注释写的是「后台抽取不得读取仍在生成的当前轮」——我们要的是同一件事：
    // 恢复时据此知道"哪些轮已经落定"，不会去碰还在写的那一轮。
    setSessionWatermark(db, sid, realIndex)

    if (cfg.vector) {
      try {
        // 2026-10-08 改：向量的索引文本从「抽取摘要」换成「用户原文」。实测（1283 轮全库 /
        // 65 条改写查询）：摘要索引下 vector R@1 只有 6.3%、彻底找不到 57/64（几乎失效）；
        // 换成原文后升到 32.8%，配合门控改动还能把整体 R@1 从 46.9% 拉到 54.7%。
        // 原因：摘要是第三人称的「本轮纪要」（中位 97 字），与用户第一人称的提问不在同一
        // 语义空间；而 BM25 一直建在原文上，所以被拖瘸的只有语义这一路。
        const embedText = String(userText || outcome.result.summary)
        const [vector] = await embed([embedText])
        if (Array.isArray(vector) && vector.length) saveTurnVector(db, record.id, embedText, vector)
      } catch { /* 向量失败只影响语义召回，词法路径不受影响 */ }
    }

    const usage = outcome.usage ?? {}
    log('info', `live sink 入库[${origin}] ${sid.slice(0, 12)}#${realIndex} [${outcome.result.outcome}·${outcome.via}] `
      + `${((Date.now() - started) / 1000).toFixed(1)}s 输入 ${usage.inputTokens ?? usage.prompt_tokens ?? '-'} 输出 ${usage.outputTokens ?? usage.completion_tokens ?? '-'}`)
    return true
  }

  /**
   * 启动恢复 —— 把上一次没抽完的轮次从会话日志里捡回来（对齐上游"重启后继续抽"的设计）。
   *
   * 为什么必须读日志：重启之后**没有活着的 session 对象**，`session.eventAt()` 走不通；
   * 会话日志是唯一真相源（这也是 backfill-core 存在的理由）。
   * 路由直接用队列表里记下的 provider/model/effort（v5）——没有它就只能放弃这一轮。
   *
   * 触发方式：**搭车在第一次 handle 上**。因为"有哪些工作区"这件事本身要先打开某个库才知道，
   * 而第一次 handle 恰好带来一个已知工作区，且那时宿主有活的 llm 服务。
   */
  async function recoverDue(workspace, loadTurns = loadCompletedTurns) {
    let db
    try { db = dbOf(workspace) } catch (error) {
      log('warn', `恢复：打开库失败（${(error && error.message) || error}）`)
      return
    }
    let due = []
    try { due = listDueExtractions(db, { limit: cfg.recoverLimit }) } catch (error) {
      log('warn', `恢复：读队列失败（${(error && error.message) || error}）`)
      return
    }
    if (!due.length) return
    log('info', `恢复：发现 ${due.length} 轮未抽取，开始补（上限 ${cfg.recoverLimit}）`)

    const bySession = new Map()
    for (const item of due) {
      const list = bySession.get(item.sessionId) ?? []
      list.push(item)
      bySession.set(item.sessionId, list)
    }

    let done = 0
    let failed = 0
    let dropped = 0
    for (const [sid, items] of bySession) {
      let loaded = null
      try { loaded = loadTurns(sid) } catch (error) {
        log('warn', `恢复：读日志失败 ${sid.slice(0, 12)}（${(error && error.message) || error}）`)
      }
      const picked = loaded ? pickTurns(loaded.turns, items) : []
      const found = new Set(picked.map((t) => Number(t.userSeq)))
      // 日志里也找不到的（旧日志已清理等）→ 记成功，不做无谓重试（省得每轮都扫它）
      for (const it of items) {
        if (!found.has(Number(it.userSeq))) {
          markExtraction(db, { ...it }, { state: 'succeeded' })
          dropped += 1
        }
      }
      for (const turn of picked) {
        const queueKey = { sessionId: sid, userSeq: turn.userSeq, answerSeq: turn.answerSeq }
        // 已经落库过（可能上一次成功了但状态没来得及写）→ 只补状态
        if (getTurn(db, turnIdOf(sid, [turn.userSeq, turn.answerSeq]))) {
          markExtraction(db, queueKey, { state: 'succeeded' })
          continue
        }
        const item = items.find((x) => Number(x.userSeq) === Number(turn.userSeq))
        const route = item && item.provider && item.model
          ? { provider: item.provider, model: item.model, reasoningEffort: item.effort || null }
          : null
        if (!route) {
          log('warn', `恢复：队列表里没有路由，跳过 ${sid.slice(0, 12)}#${turn.turnIndex}`)
          continue
        }
        // 编号**重新分配**，不用队列里记的那个：
        // 抽取失败积压时，`nextTurnIndex`（= MAX(turn_index) + 1）会对所有积压轮次返回
        // 同一个值（实测两条都记成 #23）；恢复时若照抄，就会写出重复编号，害得
        // "取最近 N 轮"这类按编号排序的地方不干净。补一条重新取一次，自然递增。
        const turnIndex = nextTurnIndex(db, sid)
        // eslint-disable-next-line no-await-in-loop
        const ok = await processTurn({
          db, sid, workspace, turnIndex,
          userSeq: turn.userSeq, answerSeq: turn.answerSeq,
          userText: turn.userText, answerText: turn.answerText,
          route, queueKey, origin: 'recover',
        })
        if (ok) done += 1
        else failed += 1
      }
    }
    log('info', `恢复完成：补 ${done} 轮，失败 ${failed}，跳过 ${dropped}`)
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

    // 2026-10-08 对齐上游 m11/m12：**先登记，再干活**。
    // 登记与状态都落库——宿主重启会清空内存里的水位与串行链（单会话就这样丢过 20 轮），
    // 但只要"待抽取"落了库，下次启动就能扫出来续抽。
    // 幂等由主键 (session_id, user_seq, answer_seq) 保证；重复触发不会重置已有状态。
    // 注意：登记必须放在 turnIndex 之后——它是 const，放前面会踩暂时性死区。
    const queueKey = { sessionId: sid, userSeq, answerSeq }
    enqueueExtraction(db, { ...queueKey, turnIndex, workspace })
    let projected
    try {
      projected = projectTurn(stub, userSeq, answerSeq, { sessionId: sid, turnIndex })
    } catch (error) {
      // 投影失败=这轮读不出来（多为日志形态问题，重试也读不出来）→ 记成功并放行，
      // 不让它一直占着队列（真要补，回填脚本那条路会重新投影）。
      log('warn', `live sink 投影失败（跳过该轮）：${(error && error.message) || error}`)
      markExtraction(db, queueKey, { state: 'succeeded' })
      return
    }
    if (!projected) {
      markExtraction(db, queueKey, { state: 'succeeded' })
      return
    }

    // 登记第二次：这次带上路由（v5）。恢复抽取发生在重启之后、那时没有活着的
    // session，`resolveRoute` 问不到 provider/model —— 不在这里记下来，那一轮就永远救不回来。
    // enqueueExtraction 用 COALESCE 合并，所以这次传的值只会补上、不会抹掉先前的。
    const route = resolveRoute(session, cfg)
    enqueueExtraction(db, {
      ...queueKey, turnIndex, workspace,
      provider: route?.provider ?? null, model: route?.model ?? null, effort: route?.reasoningEffort ?? null,
    })
    if (!route) { log('warn', 'live sink 拿不到 provider/model，跳过该轮'); return }

    await processTurn({
      db, sid, workspace, turnIndex, userSeq, answerSeq,
      userText: projected.userText, answerText: projected.answerText,
      route, queueKey, origin: 'live',
    })
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

  return { onSessionEvent, state, dispose, handle, recoverDue }
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
