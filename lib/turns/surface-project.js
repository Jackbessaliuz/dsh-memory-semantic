/**
 * surface-project —— 在模型可见表面上做「轮内过程投影」（真投影，2026-11-18）
 *
 * ## 它做什么
 *
 * 把某一**已完成轮**里「用户问题之后、最终可见回答之前」的中间轨迹（tool/call、tool/result、
 * 没有可见文本的 assistant/message）从 `session.surface.nodes` 上换成一**行常量标记**。
 * 问题与最终回答两个端点保留；原始事件永远留在不可变日志里，`recall_events` 能按 seq 取回。
 *
 * ## 为什么只能整节点折（两条死路，见 guard/thinking-guard.mjs）
 *
 *  ① `assistant/message` 自带 stream，**不许带 `sourceEventSeqs`**，而表面替换要求覆盖每个
 *     被遮蔽节点 → 不能"复制一条消息删掉 reasoning 再替换"。
 *  ② 进程内插件**没法持久化自定义事件类型**：加载器拒绝"未知且非 ignorable"的事件，
 *     实测整个会话直接读不出来。所以标记只能用**核心事件类型**（user/message）。
 *
 * ## 安全判据（GPT 评审红线，逐条落实）
 *
 *  · **不把"首问与最终回答之间"一律当作可隐藏**：中间只要出现**有可见文本的节点**
 *    （用户补充、指令更新、需要保留的说明），该轮就**整轮放弃**，不折、不改、只报告原因。
 *  · 只折**连续**的可折段；不连续就放弃（第一版不做分段折叠）。
 *  · 计价失败即整轮放弃：`tokenMeter` 拿不到、或任一被遮蔽 seq 没有价格 → 抛错不折。
 *  · 两次 append 不等一个事务：先写 prune 审计、再写替换；任何一步抛错都如实上报，
 *    由调用方记账（`committed: false`）。
 *  · 只处理 `surfaceOp` 为 append 的原点节点，已替换过的副本不再处理（天然幂等）。
 */

import { isFoldableNode, hasVisibleText, charsOfEvent } from '../takeover.js'

const defaultSource = () => ({ kind: 'plugin:dsh-memory-semantic', form: 'notice', summary: 'surface projection' })

/**
 * 把 surface 切成"轮"（与 takeover.js 的估算同口径）。
 * @returns {Array<{index:number, userSeq:number, answerSeq:number|null, answerPos:number, inner:number[]}>}
 *   `inner` 是**按表面顺序**排列的 seq 数组；`answerPos` 是最终回答在 inner 里的**下标**
 *   （2026-11-18 修：绝不能用 `seq < answerSeq` 判断前后——表面发生替换后，
 *   seq 数值顺序与表面位置顺序不再一致）
 */
export function splitSurfaceTurns(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const at = (seq) => { try { return session.eventAt(seq) } catch { return undefined } }
  const turns = []
  let cur = null
  for (const seq of nodes) {
    const ev = at(seq)
    if (!ev) continue
    const kind = ev?.data?.source?.kind ?? ev?.message?.source?.kind
    if (ev.type === 'user/message' && kind === 'user') {
      cur = { index: turns.length, userSeq: seq, answerSeq: null, answerPos: -1, inner: [] }
      turns.push(cur)
      continue
    }
    if (!cur) continue
    cur.inner.push(seq)
    if (hasVisibleText(ev)) { cur.answerSeq = seq; cur.answerPos = cur.inner.length - 1 }
  }
  return turns
}

/**
 * 单个节点的投影资格（唯一判据，planner / 估算 / 执行共用）。
 * @returns {{foldable:boolean, callIds:string[], why?:string}}
 */
export function nodeFoldInfo(ev) {
  if (!ev) return { foldable: false, callIds: [], why: 'missing' }
  if (ev.type === 'tool/result') {
    const id = ev?.data?.message?.toolCallId ?? ev?.data?.toolCallId ?? null
    return { foldable: true, callIds: id ? [String(id)] : [] }
  }
  if (ev.type === 'tool/call') {
    const id = ev?.data?.callId ?? null
    return { foldable: true, callIds: id ? [String(id)] : [] }
  }
  if (ev.type !== 'assistant/message') {
    return { foldable: false, callIds: [], why: `类型 ${ev.type} 不参与投影` }
  }
  const blocks = Array.isArray(ev?.data?.message?.content) ? ev.data.message.content : []
  const callIds = blocks.filter((b) => b?.type === 'tool-call' && b?.id).map((b) => String(b.id))
  const hasText = blocks.some((b) => b?.type === 'text' && String(b.text ?? '').trim())
  if (hasText) return { foldable: false, callIds, why: '有可见文本' }
  // 未知块类型（图片/附件/引用…）一律保留：只认我们完全理解的三种块
  const unknown = blocks.some((b) => b && !['text', 'reasoning', 'tool-call', 'tool-result'].includes(b.type))
  if (unknown) return { foldable: false, callIds, why: '含未知块类型' }
  return { foldable: true, callIds }
}

/**
 * 工具依赖完整性约束（2026-11-18 GPT 评审指出的最严重风险）：
 * 一个工具调用与它的结果必须**同进退**——保留调用就保留结果，隐藏结果就同时隐藏调用。
 * 做法：按 callId 把节点分组，组内只要有一个不可折，整组都不可折，反复传播到不动点。
 */
function applyToolDependencyConstraints(items) {
  const groups = new Map()
  for (const it of items) {
    for (const id of it.info.callIds) {
      if (!groups.has(id)) groups.set(id, [])
      groups.get(id).push(it)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [, list] of groups) {
      if (!list.some((it) => !it.info.foldable)) continue
      for (const it of list) {
        if (it.info.foldable) {
          it.info = { ...it.info, foldable: false, why: '工具依赖组里有保留节点' }
          changed = true
        }
      }
    }
  }
}

/** 生成一段投影标记的正文（真实文本，长度即真实开销）。 */
export function markerTextOf(session, seg, options = {}) {
  const turnLabel = Number.isInteger(seg.turnIndex) ? seg.turnIndex : '?'
  const shortId = String(session?.header?.id ?? session?.id ?? '').replace(/^session-/, '').slice(0, 8)
  const tokens = Number.isFinite(seg.shadowedTokens) ? `~${seg.shadowedTokens} tokens` : `约 ${Math.round(seg.shadowedChars / 2)} tokens`
  return [
    `<dsh-memory-semantic-fold turn="${turnLabel}" events="${seg.shadowedSeqs.length}" seq="${seg.start}-${seg.end}">`,
    `第 ${turnLabel} 轮的一段中间过程（${seg.shadowedSeqs.length} 条事件，${tokens}）已从可见上下文投影掉；`,
    `该轮的提问与最终回答、以及其他可见内容仍然保留。`,
    `要看当时到底跑了什么、读到了什么：recall_events({ session: "${shortId}", turn: ${turnLabel} })`,
    `（历史快照，不是重新运行工具。）`,
    '</dsh-memory-semantic-fold>',
  ].join('\n')
}

/**
 * **生成投影计划**——估算、演练、执行都消费同一份计划，不再各写一套判据。
 *
 * @param {object} session
 * @param {{keepTurns?:number, turnIndex?:number}} options
 * @returns {{
 *   ok:boolean, reason?:string,
 *   plan: Array<{turnIndex, userSeq, answerPos, segments: Array<{start, end, shadowedSeqs, shadowedChars, markerChars, marker}>}>,
 *   totals: {turns, segments, nodes, chars, markerChars, netChars}
 * }}
 */
export function planProjection(session, options = {}) {
  const keepTurns = Math.max(1, Number(options.keepTurns) || 13)
  const turns = splitSurfaceTurns(session)
  const at = (seq) => { try { return session.eventAt(seq) } catch { return undefined } }
  const empty = { plan: [], totals: { turns: turns.length, segments: 0, nodes: 0, chars: 0, markerChars: 0, netChars: 0 } }

  if (turns.length <= keepTurns) {
    return { ok: false, reason: `只有 ${turns.length} 轮（未超过 keepTurns=${keepTurns}），没有可折区`, ...empty }
  }
  const freezeTo = turns.length - keepTurns
  const want = Number.isInteger(options.turnIndex) ? Number(options.turnIndex) : null
  if (want !== null && (want < 0 || want >= freezeTo)) {
    return { ok: false, reason: `第 ${want} 轮不在可折区（0~${freezeTo - 1}）`, ...empty }
  }
  const targets = want !== null ? [turns[want]] : turns.slice(0, freezeTo)

  const plan = []
  const totals = { turns: turns.length, segments: 0, nodes: 0, chars: 0, markerChars: 0, netChars: 0, zoneChars: 0 }
  // 分母：可折区全部表面节点的字符（含保留的提问/回答/可见文本），与执行器同一口径
  for (const t of targets) {
    totals.zoneChars += charsOfEvent(at(t.userSeq))
    for (const seq of t.inner) totals.zoneChars += charsOfEvent(at(seq))
  }

  for (const t of targets) {
    if (!t.answerSeq) continue
    // **按表面位置切片**（不是 seq 比较）
    const middleSeqs = t.answerPos >= 0 ? t.inner.slice(0, t.answerPos) : t.inner.slice()
    if (middleSeqs.length === 0) continue

    const items = middleSeqs.map((seq) => ({ seq, ev: at(seq), info: nodeFoldInfo(at(seq)) }))
    applyToolDependencyConstraints(items)

    // 找连续的可折段（≥2 个节点）。分完段还要做一次**段边界**的工具组校验
    // （2026-11-19 GPT 评审：调用在段内、结果被保护节点隔到段外时，会出现"只折调用留结果"）
    const buildSegments = () => {
      const out = []
      let c = null
      for (const it of items) {
        if (it.info.foldable) {
          if (!c) { c = []; out.push(c) }
          c.push(it.seq)
        } else c = null
      }
      return out
    }
    const groupOf = new Map() // callId -> [seq...]（该工具组涉及的全部节点）
    for (const it of items) {
      for (const id of it.info.callIds) {
        if (!groupOf.has(id)) groupOf.set(id, [])
        groupOf.get(id).push(it.seq)
      }
    }
    let segments = buildSegments()
    for (let guard = 0; guard < 4; guard += 1) {
      const segIndex = new Map()
      segments.forEach((g, i) => { for (const s of g) segIndex.set(s, i) })
      let broke = false
      for (const [, group] of groupOf) {
        const segs = new Set(group.filter((s) => segIndex.has(s)).map((s) => segIndex.get(s)))
        const wholeInOneSeg = group.every((s) => segIndex.has(s)) && segs.size === 1
        if (wholeInOneSeg) continue
        for (const it of items) {
          if (!it.info.foldable || !group.includes(it.seq)) continue
          it.info = { ...it.info, foldable: false, why: '工具组跨段，整组保留' }
          broke = true
        }
      }
      if (!broke) break
      segments = buildSegments()
    }
    const usable = segments.filter((g) => g.length >= 2)
    if (usable.length === 0) continue

    const built = usable.map((g) => {
      const seg = {
        turnIndex: t.index,
        start: g[0],
        end: g[g.length - 1],
        shadowedSeqs: g,
        shadowedChars: 0,
        markerChars: 0,
        marker: '',
      }
      for (const seq of g) seg.shadowedChars += charsOfEvent(at(seq))
      seg.marker = markerTextOf(session, seg)
      seg.markerChars = seg.marker.length
      return seg
    })
    plan.push({ turnIndex: t.index, userSeq: t.userSeq, answerPos: t.answerPos, segments: built })
    for (const seg of built) {
      totals.segments += 1
      totals.nodes += seg.shadowedSeqs.length
      totals.chars += seg.shadowedChars
      totals.markerChars += seg.markerChars
    }
  }

  totals.netChars = totals.chars - totals.markerChars
  if (plan.length === 0) {
    return { ok: false, reason: want !== null ? `第 ${want} 轮没有可折的中间轨迹（或全被工具依赖/可见文本保住）` : '可折区里没有符合条件的轮次', ...{ plan: [], totals } }
  }
  return { ok: true, plan, totals }
}

/**
 * 选出可折的那一段（不执行任何写入）。
 *
 * @param {object} session DSH session（需 surface.nodes + eventAt）
 * @param {{turnIndex?:number, keepTurns?:number}} options
 *   `turnIndex` 缺省＝在可折区里挑**最早**一个可折轮
 * @returns {{ok:boolean, reason?:string, ...}} ok=false 时 `reason` 说明为什么放弃
 */
export function selectFoldSegment(session, options = {}) {
  const p = planProjection(session, options)
  if (!p.ok) return { ok: false, reason: p.reason, plan: p.plan, totals: p.totals }
  const first = p.plan[0]
  const seg = first.segments[0]
  const turn = splitSurfaceTurns(session)[first.turnIndex]
  return {
    ok: true,
    turnIndex: first.turnIndex,
    userSeq: first.userSeq,
    answerSeq: turn ? turn.answerSeq : null,
    start: seg.start,
    end: seg.end,
    shadowedSeqs: seg.shadowedSeqs,
    shadowedChars: seg.shadowedChars,
    marker: seg.marker,
    plan: p.plan,
    totals: p.totals,
  }
}

/**
 * 真正执行投影：先写审计、再写替换。
 *
 * @param {object} session
 * @param {{measure:(s:object)=>{nodes:Array<{seq:number,heuristicTokens:number}>}}} tokenMeter
 * @param {object} seg selectFoldSegment 的返回值
 * @returns {{committed:boolean, pruneSeq:number|null, replacementSeq:number|null, shadowedSeqs:number[], shadowedTokenCount:number, error?:string}}
 */
export function applyFoldSegment(session, tokenMeter, seg, options = {}) {
  const result = { committed: false, pruneSeq: null, replacementSeq: null, shadowedSeqs: [...(seg?.shadowedSeqs || [])], shadowedTokenCount: 0 }
  if (typeof session?.append !== 'function') {
    result.error = 'session.append 不可用'
    return result
  }
  const measured = tokenMeter && typeof tokenMeter.measure === 'function' ? tokenMeter.measure(session) : null
  if (!measured || !Array.isArray(measured.nodes)) {
    result.error = 'tokenMeter 不可用（按红线：计价失败即放弃）'
    return result
  }
  const price = new Map(measured.nodes.map((n) => [Number(n.seq), Number(n.heuristicTokens)]))
  let total = 0
  for (const seq of result.shadowedSeqs) {
    const p = price.get(Number(seq))
    if (!Number.isFinite(p)) {
      result.error = `tokenMeter 没有给出 seq ${seq} 的计价（整轮放弃）`
      return result
    }
    total += p
  }
  result.shadowedTokenCount = total

  const turnLabel = Number.isInteger(seg?.turnIndex) ? seg.turnIndex : null
  const shortId = String(session?.header?.id ?? session?.id ?? '').replace(/^session-/, '').slice(0, 8)
  try {
    const prune = session.append('compaction/prune', {
      shadowedRange: { start: seg.start, end: seg.end },
      shadowedSeqs: [...result.shadowedSeqs],
      shadowedTokenCount: total,
      by: 'dsh-memory-semantic',
      turn: turnLabel,
    })
    result.pruneSeq = Number.isInteger(prune?.seq) ? prune.seq : null
  } catch (e) {
    result.error = `写审计事件失败：${(e && e.message) || e}`
    return result
  }

  const marker = [
    `<dsh-memory-semantic-fold turn="${turnLabel ?? '?'}" events="${result.shadowedSeqs.length}" tokens="~${total}">`,
    `第 ${turnLabel ?? '?'} 轮的中间过程（${result.shadowedSeqs.length} 条事件，约 ${total} tokens）已从可见上下文投影掉；`,
    `这一轮的提问与最终回答仍然保留。`,
    `要看当时到底跑了什么、读到了什么：recall_events({ session: "${shortId}", turn: ${turnLabel ?? 0} })`,
    `（它是历史快照，不是重新运行工具。）`,
    '</dsh-memory-semantic-fold>',
  ].join('\n')

  try {
    const replacement = session.append('user/message', {
      // 消息 ID 必须唯一：同一轮可能折多段（2026-11-19 GPT 评审指出两条标记撞了同一个 id）
      id: `dsh-memory-semantic-fold:${String(session?.header?.id ?? session?.id ?? 'session')}:${turnLabel ?? 'x'}:${seg.start}-${seg.end}`,
      role: 'user',
      source: (typeof options.sourceOf === 'function' ? options.sourceOf() : null) || defaultSource(),
      content: [{ type: 'text', text: marker }],
    }, {
      surfaceOp: { op: 'replace', startSeq: seg.start, endSeq: seg.end },
      sourceEventSeqs: [...(result.pruneSeq !== null ? [result.pruneSeq] : []), ...result.shadowedSeqs],
    })
    result.replacementSeq = Number.isInteger(replacement?.seq) ? replacement.seq : null
    result.committed = true
    return result
  } catch (e) {
    result.error = `写替换事件失败（审计已写，表面未改）：${(e && e.message) || e}`
    return result
  }
}
