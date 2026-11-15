/**
 * takeover.js —— 上下文接管的**观测层**（2026-11-16，graph-memory context takeover 的第一步）
 *
 * 背景：graph-memory 的 context takeover 会保留最近 N 轮，把已完成轮次的 reasoning/tool traces
 * 从**未来请求**里投影掉（上游实测 T20 首次请求 56,998 → 11,008 tokens、可见消息 171 → 21）。
 * 但我们之前做过 takeov-1（保留 13 轮）实验、效果不好撤了 —— 所以这里**先只观测、绝不改历史**：
 * 每次 pre-step 统计"如果按 keepTurns 投影，能省多少字符/节点、影响多少轮"，写进观测账本。
 *
 * 铁律（与 guard 一致）：
 *   · dryRun 默认 true，只记不折；
 *   · 只处理 surface 上**已完成**的轮次（不含当前进行中的这一轮）；
 *   · 观测失败绝不影响本步（fail-open）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_QUEUE = 200

export function takeoverObservationsPath(workspace) {
  return path.join(workspace, '.dsh-semantic', 'takeover-observations.ndjson')
}

/** 粗估 token：中文按 1 字 ≈ 1 token、英文按 4 字符 ≈ 1 token，取个统一保守值（字符数 / 2）。 */
function roughTokens(chars) {
  return Math.round(Number(chars) / 2)
}

/**
 * 扫一遍 surface，估算"按 keepTurns 投影"能省多少。纯函数，不做任何修改。
 * @returns {{turns:number, keepTurns:number, foldableNodes:number, reasoningChars:number, toolChars:number, visibleChars:number, estSavedTokens:number}}
 */
export function estimateTakeover(session, cfg = {}) {
  const keepTurns = Math.max(1, Number(cfg.keepTurns) || 13)
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const at = (seq) => {
    try { return session.eventAt(seq) } catch { return undefined }
  }
  // 先找出所有真实用户轮起点（plugin 注入的 user/message 不算）
  const turnStarts = []
  for (const seq of nodes) {
    const ev = at(seq)
    if (ev?.type !== 'user/message') continue
    const kind = ev?.data?.source?.kind ?? ev?.message?.source?.kind
    if (kind === 'user') turnStarts.push(seq)
  }
  const turns = turnStarts.length
  if (turns <= keepTurns) {
    return { turns, keepTurns, foldableNodes: 0, reasoningChars: 0, toolChars: 0, visibleChars: 0, estSavedTokens: 0 }
  }
  // 要投影的边界：第 (turns - keepTurns) 个轮起点之前的所有节点
  const cutoff = turnStarts[turns - keepTurns]
  const cutoffIdx = nodes.indexOf(cutoff)
  if (cutoffIdx <= 0) {
    return { turns, keepTurns, foldableNodes: 0, reasoningChars: 0, toolChars: 0, visibleChars: 0, estSavedTokens: 0 }
  }
  let foldableNodes = 0
  let reasoningChars = 0
  let toolChars = 0
  let visibleChars = 0
  for (const seq of nodes.slice(0, cutoffIdx)) {
    const ev = at(seq)
    if (!ev) continue
    foldableNodes += 1
    if (ev.type === 'tool/result') {
      const blocks = ev?.data?.message?.content ?? ev?.message?.content
      if (Array.isArray(blocks)) for (const b of blocks) toolChars += String(b?.text ?? '').length
      continue
    }
    if (ev.type !== 'assistant/message') continue
    const blocks = ev?.data?.message?.content ?? ev?.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type === 'reasoning') reasoningChars += String(b.text ?? '').length
      else if (b?.type === 'text') visibleChars += String(b.text ?? '').length
    }
  }
  // 投影后：reasoning 全去、tool 结果压成摘要（按 1/10 估）、可见文字保留
  const savedChars = reasoningChars + Math.round(toolChars * 0.9)
  return {
    turns,
    keepTurns,
    foldableNodes,
    reasoningChars,
    toolChars,
    visibleChars,
    estSavedTokens: roughTokens(savedChars),
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

export function registerTakeover(ctx, { logger, config } = {}) {
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
          const est = estimateTakeover(session, cfg)
          if (est.turns > 0) {
            lastWrite.set(session, now)
            appendObservation(workspace, {
              t: now,
              dryRun: cfg.dryRun,
              keepTurns: cfg.keepTurns,
              ...est,
            })
            if (cfg.dryRun && est.estSavedTokens > 0) {
              logger && logger.info && logger.info(
                `[takeover][dryRun] ${est.turns} 轮中可投影 ${est.foldableNodes} 节点，`
                + `估省 ~${est.estSavedTokens} tokens（reasoning ${est.reasoningChars} 字 / tool ${est.toolChars} 字）`,
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
