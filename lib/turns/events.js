/**
 * events —— 按轮次 / seq 范围读取**不可变日志**里的原始事件（证据回查层）
 *
 * ## 为什么需要它（2026-11-18，GPT 评审指出的缺口）
 *
 * 轮次库 `turns.db` 存的是「首问 + 最终回答」——投影（把中间 reasoning/工具轨迹从模型可见
 * 表面藏起来）之后，`recall_turns` 能拿回的仍只是**已经留在表面上的问答**，取不回
 * "当时跑了哪些命令、读到的文件内容是什么"。所以「投影后需要时能完整取回」这句话，
 * 必须由这一层兑现：**直接读会话不可变日志，按 seq 取原文**。
 *
 * 两个动作要分清（GPT Q2）：
 *   · 读历史工具结果 = 知道**当时**查到了什么（本模块）
 *   · 重新跑工具 = 观察**现在**是什么（可能是另一个答案；文件/网页/进程状态已变）
 *
 * ## 只读
 *
 * 只读 `session.v4.jsonl.zstd`，不写任何 DSH 数据。
 * 事件里 `data.stream`（流式 chunk 数组）体积巨大且无证据价值，摘要时**一律丢弃**。
 */
import { readSessionEvents } from './session-log.js'

/** 摘要输出里绝不带出的字段（体积大、且不是"证据"）。 */
const DROP_KEYS = new Set(['stream', 'replayState'])

/** 该事件是不是"真实用户轮"的起点（plugin 注入的 user/message 不算）。 */
export function isRealUserPrompt(ev) {
  if (ev?.type !== 'user/message') return false
  const kind = ev?.data?.source?.kind ?? ev?.message?.source?.kind
  return kind === 'user'
}

function blocksOf(ev) {
  const c = ev?.data?.message?.content ?? ev?.data?.content ?? ev?.message?.content
  return Array.isArray(c) ? c : []
}
function joinText(blocks) {
  return blocks
    .filter((b) => b && b.type === 'text' && String(b.text ?? '').trim())
    .map((b) => String(b.text))
    .join('\n')
    .trim()
}
function chars(n) {
  return Math.max(0, Number(n) || 0)
}

/**
 * 把事件流切成一串"真实用户轮窗口"。
 * @returns {Array<{index:number, userSeq:number, from:number, to:number, eventCount:number}>}
 *   `from` / `to` 都是 seq（闭区间），index 从 0 起——与 `tm_turns.turn_index` 同基准
 *   （tm_turns 的编号就是按"真实用户轮"顺序分配的）。
 */
export function buildTurnWindows(events) {
  const list = Array.isArray(events) ? events : []
  const starts = []
  for (const ev of list) if (isRealUserPrompt(ev)) starts.push(Number(ev.seq))
  const windows = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] - 1 : (list.length > 0 ? Number(list[list.length - 1].seq) : from)
    let count = 0
    for (const ev of list) {
      const s = Number(ev.seq)
      if (s >= from && s <= to) count += 1
    }
    windows.push({ index: i, userSeq: from, from, to, eventCount: count })
  }
  return windows
}

/** 按 seq 闭区间切片（events 不一定连续，用 seq 比较而不是下标）。 */
export function sliceBySeq(events, from, to) {
  const lo = Number.isFinite(Number(from)) ? Number(from) : -Infinity
  const hi = Number.isFinite(Number(to)) ? Number(to) : Infinity
  return (Array.isArray(events) ? events : []).filter((ev) => {
    const s = Number(ev?.seq)
    return Number.isFinite(s) && s >= lo && s <= hi
  })
}

/**
 * 单个事件 → 可读摘要（永远不含 stream / replayState）。
 * @returns {{seq, type, turn?, step?, kind?, name?, callId?, isError?, chars, text?, usage?}}
 */
export function summarizeEvent(ev, options = {}) {
  // 上限 4000：工具描述里承诺的区间必须真的执行（2026-11-18 GPT 指出说明与实现不一致）
  const maxChars = Math.max(80, Math.min(4000, Number(options.maxChars) || 900))
  const clip = (text) => {
    const t = String(text ?? '').replace(/\r/g, '')
    return t.length > maxChars ? `${t.slice(0, maxChars)}…[+${t.length - maxChars}字]` : t
  }
  const out = { seq: Number(ev?.seq), type: String(ev?.type || '') }
  const data = ev?.data ?? {}

  if (ev?.type === 'user/message') {
    out.kind = data?.source?.kind ?? ev?.message?.source?.kind ?? ''
    const text = joinText(blocksOf(ev))
    out.chars = text.length
    if (text) out.text = clip(text)
    return out
  }

  if (ev?.type === 'assistant/message') {
    if (Number.isFinite(Number(data?.turn))) out.turn = Number(data.turn)
    if (Number.isFinite(Number(data?.step))) out.step = Number(data.step)
    const blocks = blocksOf(ev)
    const reasoning = blocks.filter((b) => b?.type === 'reasoning').map((b) => String(b.text ?? '')).join('\n')
    const visible = joinText(blocks)
    const calls = blocks.filter((b) => b?.type === 'tool-call').map((b) => ({
      name: String(b.name ?? ''),
      args: clip(String(b.arguments ?? b.args ?? '')).slice(0, Math.min(300, maxChars)),
    }))
    const total = reasoning.length + visible.length
    out.chars = total
    out.reasoningChars = reasoning.length
    if (visible) out.text = clip(visible)
    if (calls.length) out.toolCalls = calls
    if (data?.usage) {
      const u = data.usage
      out.usage = {
        input: Number(u.inputTokens) || 0,
        output: Number(u.outputTokens) || 0,
        cacheRead: Number(u.cacheReadTokens) || 0,
      }
    }
    return out
  }

  if (ev?.type === 'tool/call') {
    if (Number.isFinite(Number(data?.turn))) out.turn = Number(data.turn)
    out.name = String(data?.name ?? '')
    out.callId = String(data?.callId ?? '')
    const args = String(data?.arguments ?? data?.args ?? '')
    out.chars = args.length
    if (args) out.text = clip(args)
    return out
  }

  if (ev?.type === 'tool/result') {
    if (Number.isFinite(Number(data?.turn))) out.turn = Number(data.turn)
    out.callId = String(data?.message?.toolCallId ?? data?.toolCallId ?? '')
    const isError = data?.message?.isError ?? data?.isError
    if (isError !== undefined) out.isError = Boolean(isError)
    const text = joinText(blocksOf(ev))
    out.chars = text.length
    if (text) out.text = clip(text)
    return out
  }

  // 其他事件（turn/start、compaction/prune、system/message…）：只报类型与粗体量
  out.chars = data ? String(JSON.stringify(data)).length : 0
  if (ev?.type === 'compaction/prune' && data) {
    out.shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.slice(0, 40) : []
    out.shadowedTokenCount = Number(data.shadowedTokenCount) || 0
  }
  return out
}

/**
 * 读一个会话日志并按条件取事件。
 *
 * @param {string} logFile session.v4.jsonl.zstd 路径
 * @param {{from?:number,to?:number,turnIndex?:number,userSeq?:number,types?:string[],limit?:number,maxChars?:number}} options
 *   - `types` 传空数组/省略 = 不过滤
 *   - 给了 `turnIndex` 或 `userSeq` 就按该轮窗口取；否则按 from/to
 * @returns {{ok:true, header:{id?:string}, windows:number, range:number[], total:number, events:object[], truncated:boolean}}
 */
export function readEvents(logFile, options = {}) {
  const { header, events } = readSessionEvents(logFile)
  const windows = buildTurnWindows(events)

  let from = Number.isFinite(Number(options.from)) ? Number(options.from) : null
  let to = Number.isFinite(Number(options.to)) ? Number(options.to) : null

  // 按轮取：优先 userSeq（可由 tm_turns 给出，容忍 turn_index 编号不连续），否则按序号。
  // 显式指定了坐标却找不到，**必须明确失败**——绝不允许悄悄退回"整个会话范围"
  // （2026-11-18 GPT 评审指出：那样调用方会以为拿到了指定轮次，实际拿到全库）。
  if (from === null && (Number.isInteger(options.userSeq) || Number.isInteger(options.turnIndex))) {
    let win = null
    if (Number.isInteger(options.userSeq)) win = windows.find((w) => w.userSeq === Number(options.userSeq)) || null
    if (!win && Number.isInteger(options.turnIndex)) win = windows[Number(options.turnIndex)] || null
    if (!win) {
      return {
        ok: false,
        error: `指定的轮次不在这份日志里（turnIndex=${Number.isInteger(options.turnIndex) ? options.turnIndex : '—'}`
          + ` / userSeq=${Number.isInteger(options.userSeq) ? options.userSeq : '—'}；该会话实际有 ${windows.length} 轮）`,
        header: { id: typeof header?.id === 'string' ? header.id : null },
        windows: windows.length,
        range: [null, null],
        total: 0,
        events: [],
        truncated: false,
      }
    }
    from = win.from
    to = win.to
  }
  const lo = from === null ? -Infinity : from
  const hi = to === null ? Infinity : to

  const typeFilter = Array.isArray(options.types) && options.types.length > 0
    ? new Set(options.types.map(String))
    : null

  let picked = sliceBySeq(events, lo, hi)
  if (typeFilter) picked = picked.filter((ev) => typeFilter.has(String(ev?.type)))

  const limit = Math.max(1, Math.min(50, Number(options.limit) || 12))
  const truncated = picked.length > limit
  const shown = picked.slice(0, limit)
  return {
    ok: true,
    header: { id: typeof header?.id === 'string' ? header.id : null },
    windows: windows.length,
    range: [from === null ? Number(events[0]?.seq ?? 0) : from, to === null ? Number(events[events.length - 1]?.seq ?? 0) : to],
    total: picked.length,
    events: shown.map((ev) => summarizeEvent(ev, { maxChars: options.maxChars })),
    truncated,
  }
}

/** 供测试/诊断：某会话里有几轮、每轮多少事件。 */
export function turnWindowSummary(logFile) {
  const { events } = readSessionEvents(logFile)
  return buildTurnWindows(events)
}

export { DROP_KEYS }
