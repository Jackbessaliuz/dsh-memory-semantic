/**
 * takeover.js —— 上下文接管的**观测层**（2026-11-16 起；2026-11-18 口径修正）
 *
 * 背景：graph-memory 的 context takeover 会保留最近 N 轮，把已完成轮次的 reasoning/tool traces
 * 从**未来请求**里投影掉。但我们之前做过 takeov-1（保留 13 轮）实验、效果不好撤了 ——
 * 所以这里**先只观测、绝不改历史**：每次 pre-step 统计"如果投影，能省多少字符/节点、影响多少轮"。
 *
 * ── 2026-11-18 口径修正（GPT 评审指出，已实测验证）──────────────────────
 *
 * 旧实现有两个错，合起来把收益**高估 13.5%~15.7%**（三个大会话实测）：
 *
 *  ① **把最终回答节点内嵌的 reasoning 也算进了可省**。但整节点方案（唯一能走通的路，
 *     见 guard/thinking-guard.mjs 里"assistant/message 自带 stream 不许带 sourceEventSeqs"
 *     与"自定义事件类型落盘会让整个会话读不出来"两条实证）**必须保留最终回答节点**，
 *     它里面的 reasoning 折不掉。实测这部分被误算 45K~82K 字/会话。
 *
 *  ② **分母只有 assistant 消息的内容**，没算用户正文与工具调用参数，于是算出"92.8%"这种
 *     看起来能省掉绝大多数的数字。换成"cutoff 前全部事件字符"后，真实可折是 **46%~52%**。
 *
 * 新口径因此改成：
 *   · 只折「完整轮」里 **问题之后、最终回答之前** 的节点（最终回答整体保留）；
 *   · 分母＝cutoff 前**全部**事件字符（用户正文 + reasoning + 可见文本 + 工具参数 + 工具结果）；
 *   · 分子不再乘 0.9 的"压摘要"系数——整节点替换是换成一行常量标记，不是压缩；
 *   · 扣掉每段标记本身的固定开销；**未完成轮整轮跳过**（问题在、回答还没落）。
 *
 * 铁律（与 guard 一致）：
 *   · dryRun 默认 true，只记不折；
 *   · 只处理 surface 上**已完成**的轮次（不含当前进行中的这一轮）；
 *   · 观测失败绝不影响本步（fail-open）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_QUEUE = 200
/** 估算口径版本：账本里带着它，跨版本的数据不能直接对比。 */
export const ESTIMATE_POLICY_VERSION = 2
export const LEDGER_POLICY_VERSION = 3
/** 每段投影标记的固定开销（`<...-trace turn="N">Intermediate tool trace archived...</...>` 约 120 字）。 */
const MARKER_CHARS = 120

export function takeoverObservationsPath(workspace) {
  return path.join(workspace, '.dsh-semantic', 'takeover-observations.ndjson')
}

/** 粗估 token：中文按 1 字 ≈ 1 token、英文按 4 字符 ≈ 1 token，取个统一保守值（字符数 / 2）。 */
function roughTokens(chars) {
  return Math.round(Number(chars) / 2)
}

function blocksOf(ev) {
  const c = ev?.data?.message?.content ?? ev?.data?.content ?? ev?.message?.content
  return Array.isArray(c) ? c : []
}

/** 该 assistant 消息有没有可见文本（只有 reasoning / tool-call 的不算"已作答"）。 */
export function hasVisibleText(ev) {
  if (ev?.type !== 'assistant/message') return false
  return blocksOf(ev).some((b) => b && b.type === 'text' && String(b.text ?? '').trim().length > 0)
}

/** 一个事件"进请求"的近似字符量。 */
export function charsOfEvent(ev) {
  if (!ev) return 0
  let n = 0
  for (const b of blocksOf(ev)) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' || b.type === 'reasoning') n += String(b.text ?? '').length
    else if (b.type === 'tool-call') n += String(JSON.stringify(b.args ?? b.input ?? {})).length
    else if (b.type === 'tool-result') n += String(b.text ?? b.content ?? '').length
    else n += 8
  }
  if (ev.type === 'tool/result' && n === 0) n = String(JSON.stringify(ev.data ?? '')).length
  return n
}

function reasoningCharsOf(ev) {
  let n = 0
  for (const b of blocksOf(ev)) if (b && b.type === 'reasoning') n += String(b.text ?? '').length
  return n
}

function toolCharsOf(ev) {
  if (ev?.type !== 'tool/result') return 0
  let n = 0
  for (const b of blocksOf(ev)) n += String(b?.text ?? '').length
  return n || String(JSON.stringify(ev.data ?? '')).length
}

function visibleCharsOf(ev) {
  let n = 0
  for (const b of blocksOf(ev)) if (b && b.type === 'text') n += String(b.text ?? '').length
  return n
}

/**
 * **一个节点在"整节点替换"方案下能不能折掉**——这是收益估算的关键判据（2026-11-18 补）。
 *
 * 整节点替换只能整块换掉，**不能只删节点里的 reasoning 而留下 text**（那需要改写事件内容，
 * 而 assistant/message 自带 stream、不允许带 sourceEventSeqs，见 guard 里的两条实证）。
 * 所以：
 *   · `tool/result` 节点、纯 `tool/call` 节点 → 可折
 *   · **没有可见 text 的** `assistant/message`（纯 reasoning / 纯工具调用）→ 可折
 *   · **有可见 text 的** `assistant/message` → 整节点保留，它内嵌的 reasoning 一起留下
 */
export function isFoldableNode(ev) {
  if (!ev) return false
  if (ev.type === 'tool/result') return true
  if (ev.type === 'tool/call') return true   // 独立的工具调用节点：没有可见文本，可折
  if (ev.type !== 'assistant/message') return false
  return !hasVisibleText(ev)
}

/**
 * 扫一遍 surface，估算"按 keepTurns 投影"能省多少。纯函数，不做任何修改。
 *
 * @returns {{
 *   turns:number, keepTurns:number, foldableTurns:number, foldableNodes:number,
 *   reasoningChars:number, toolChars:number, visibleChars:number,
 *   keptAnswerReasoningChars:number, totalChars:number,
 *   savedChars:number, estSavedTokens:number, savedPct:number,
 *   policyVersion:number
 * }}
 *   - `reasoningChars`/`toolChars`：**真正可折的**（中间轨迹），已排除最终回答内的 reasoning
 *   - `keptAnswerReasoningChars`：最终回答节点里被保留的 reasoning（旧口径会误算进收益）
 *   - `totalChars`：cutoff 前全部事件字符＝新分母
 */
export function estimateTakeover(session, cfg = {}) {
  const keepTurns = Math.max(1, Number(cfg.keepTurns) || 13)
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const at = (seq) => {
    try { return session.eventAt(seq) } catch { return undefined }
  }
  const empty = {
    turns: 0, keepTurns, foldableTurns: 0, foldableNodes: 0,
    reasoningChars: 0, toolChars: 0, visibleChars: 0,
    keptAnswerReasoningChars: 0, totalChars: 0,
    savedChars: 0, estSavedTokens: 0, savedPct: 0,
    policyVersion: ESTIMATE_POLICY_VERSION,
  }
  if (nodes.length === 0) return empty

  // 按 surface 顺序切成"轮"：真用户消息开一轮，之后到下一个真用户消息为止；
  // 该轮最后一个有可见文本的 assistant/message ＝ 最终回答（保留节点）。
  const turns = []
  let cur = null
  for (const seq of nodes) {
    const ev = at(seq)
    if (!ev) continue
    const kind = ev?.data?.source?.kind ?? ev?.message?.source?.kind
    if (ev.type === 'user/message' && kind === 'user') {
      cur = { userSeq: seq, answerSeq: null, inner: [] }
      turns.push(cur)
      continue
    }
    if (!cur) continue // 首轮之前的 system prompt / 运行时块：不在任何轮内
    cur.inner.push(seq)
    if (hasVisibleText(ev)) cur.answerSeq = seq
  }

  const total = turns.length
  if (total <= keepTurns) return { ...empty, turns: total }

  const foldable = turns.slice(0, total - keepTurns)
  let foldableTurns = 0
  let foldableNodes = 0
  let reasoningChars = 0
  let toolChars = 0
  let visibleChars = 0
  let keptAnswerReasoningChars = 0
  let keptInnerReasoningChars = 0
  let totalChars = 0

  for (const t of foldable) {
    // 分母：这一轮全部可见节点（问题 + 轨迹 + 最终回答）
    totalChars += charsOfEvent(at(t.userSeq))
    for (const seq of t.inner) totalChars += charsOfEvent(at(seq))

    // 未完成轮（回答还没落）整轮跳过——折了会把进行中的上下文挖空
    if (!t.answerSeq) continue
    foldableTurns += 1
    for (const seq of t.inner) {
      if (seq >= t.answerSeq) continue // 最终回答及之后保留
      const ev = at(seq)
      if (!ev) continue
      if (!isFoldableNode(ev)) {
        // 有可见文本的中间节点：整节点保留，它内嵌的 reasoning 折不掉
        visibleChars += visibleCharsOf(ev)
        if (ev.type === 'assistant/message') keptInnerReasoningChars += reasoningCharsOf(ev)
        continue
      }
      foldableNodes += 1
      if (ev.type === 'assistant/message') reasoningChars += reasoningCharsOf(ev)
      else if (ev.type === 'tool/result') toolChars += toolCharsOf(ev)
    }
    keptAnswerReasoningChars += reasoningCharsOf(at(t.answerSeq))
  }

  // 每折一段（这里按轮折）落一个常量标记，扣掉它的开销
  const savedChars = Math.max(0, reasoningChars + toolChars - foldableTurns * MARKER_CHARS)
  return {
    turns: total,
    keepTurns,
    foldableTurns,
    foldableNodes,
    reasoningChars,
    toolChars,
    visibleChars,
    keptAnswerReasoningChars,
    keptInnerReasoningChars,
    totalChars,
    savedChars,
    estSavedTokens: roughTokens(savedChars),
    savedPct: totalChars > 0 ? Number((100 * savedChars / totalChars).toFixed(1)) : 0,
    policyVersion: ESTIMATE_POLICY_VERSION,
  }
}

/** 把一次观测追加到账本（异步、静默失败）。 */
function appendObservation(workspace, record) {
  try {
    const file = takeoverObservationsPath(workspace)
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFile(file, JSON.stringify(record) + '\n', () => {})
  } catch { /* 观测失败不影响任何事 */ }
}

/**
 * 把 planner 的计划换算成账本字段——**估算与执行共用同一份判据**（2026-11-18 GPT 评审：
 * 之前估算按类型累加、执行整轮跳过，同一份数据一个报 1480 字一个报 0）。
 */
function planToLedger(pr, keepTurns) {
  const tt = (pr && pr.totals) || {}
  const net = Number(tt.netChars) || 0
  const zone = Number(tt.zoneChars) || 0
  return {
    turns: Number(tt.turns) || 0,
    keepTurns,
    foldableTurns: Array.isArray(pr?.plan) ? pr.plan.length : 0,
    foldableSegments: Number(tt.segments) || 0,
    foldableNodes: Number(tt.nodes) || 0,
    savedChars: net,
    markerChars: Number(tt.markerChars) || 0,
    estSavedTokens: Math.round(net / 2),
    savedPct: zone > 0 ? Number((100 * net / zone).toFixed(1)) : 0,
    policyVersion: LEDGER_POLICY_VERSION,
    estimator: 'planner',
  }
}

export function registerTakeover(ctx, { logger, config, planProjection } = {}) {
  const raw = (config && config.takeover) || {}
  const cfg = {
    enabled: raw.enabled !== false,
    dryRun: raw.dryRun !== false, // 默认演练：只观测
    keepTurns: Number(raw.keepTurns) > 0 ? Number(raw.keepTurns) : 13,
  }
  if (!cfg.enabled) {
    logger && logger.info && logger.info('[takeover] 已禁用')
    return
  }
  const lastWrite = new Map() // session -> 上次写观测的时间（节流 60s）
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      const session = agent?.session
      const workspace = session?.header?.cwd
      if (session && workspace && !signal?.aborted) {
        const now = Date.now()
        const prev = lastWrite.get(session) || 0
        if (now - prev >= 60000) {
          // 有 planner 就用它（估算＝计划，避免两套判据打架）；没有就退回旧估算
          let est
          if (typeof planProjection === 'function') {
            try { est = planToLedger(planProjection(session, { keepTurns: cfg.keepTurns }), cfg.keepTurns) }
            catch { est = estimateTakeover(session, cfg) }
          } else {
            est = estimateTakeover(session, cfg)
          }
          if (est.turns > 0) {
            lastWrite.set(session, now)
            appendObservation(workspace, {
              t: now,
              dryRun: cfg.dryRun,
              keepTurns: cfg.keepTurns,
              ...est,
              // 稳定身份：没有会话 id 与表面代次，事后无法把"这次投影"和"之后的请求"串起来
              sessionId: String(session?.header?.id ?? ''),
              surfaceNodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : 0,
            })
            if (cfg.dryRun && est.estSavedTokens > 0) {
              logger && logger.info && logger.info(
                `[takeover][dryRun] ${est.turns} 轮（可折 ${est.foldableTurns} 轮 / `
                + `${est.foldableSegments || 0} 段 / ${est.foldableNodes} 节点），`
                + `净省 ${est.savedChars} 字（标记占 ${est.markerChars || 0}）≈ 可折区的 ${est.savedPct}%，`
                + `估省 ~${est.estSavedTokens} tokens｜口径 v${est.policyVersion}`,
              )
            }
          }
        }
      }
    } catch (error) {
      logger && logger.warn && logger.warn(`[takeover] 观测失败（已忽略）：${String(error && error.message || error)}`)
    }
    return next()
  })
}
