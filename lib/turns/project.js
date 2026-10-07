/**
 * project —— 宿主轮次投影：把 DSH 不可变事件日志投影成"一轮抽取输入"
 *
 * 移植自 graph-memory `src/format/dsh-turn-projection.ts`（1.6.0-beta.16），
 * 语义一条不改：一轮只取**首个真实用户消息** + **最后一个含可见文本的助手回答**。
 * 中间那些 reasoning / 工具调用 / 中间草稿 —— 一律不进抽取输入。
 *
 * 我们多做的两件事（DSH 现实决定）：
 *  1. **剥离注入块**：meow-memory 会把注入内容重写进用户消息 content 的头部并落盘，
 *     所以日志里的"用户消息"往往是 `[注入块, ...真正的提问]`。抽取要的是后者。
 *  2. **保留图片等非文本块的占位**：不让视觉内容在文本投影里凭空消失。
 *
 * 纯函数，不读盘、不写盘；事件数组由调用方（session-log / 宿主 snapshotEvents）提供。
 */

/**
 * 注入块识别标记。
 *
 * 实测修正（2026-09-23，会话 session-ec92f1e9，1610 事件 / 36 完成轮）：
 * DSH 里的记忆注入**通常是独立的 user/message 事件**——
 *   `source = { kind:'plugin', plugin:'meow-memory', form:'snapshot' }`（长期记忆 / 关键词命中）、
 *   `{ kind:'plugin', plugin:'dsh-memory-semantic', form:'notice' }`（动作触发 / 接力）。
 * 真实用户消息的 content 是干净的（`source.kind === 'user'`，如 [image,image,image,text]），
 * 因此 {@link isRealUserTurn} 一句就足以排除注入。
 *
 * 那为什么还留这层文本剥离？因为存在"注入块被重写进真实用户消息 content 头部"的形态
 * （早期 meow-memory 的落盘实证），那种情况下 content 会是 `[注入块, ...原内容]`。
 * 两种形态可能并存，这里按保险层处理：命中即剥，没命中就什么都不做。
 */
export const INJECTION_MARKERS = [
  '===== 长期记忆 =====',
  '可能相关的记忆，仅供参考',
  '【记忆自动注入',
  '【接力上下文',
  '【meow-memory',
]

/** 该 text block 是否是插件注入物。 */
export function isInjectionBlock(block) {
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return false
  const head = block.text.trimStart()
  return INJECTION_MARKERS.some((marker) => head.startsWith(marker) || head.includes(marker))
}

/**
 * 拆开一条用户消息的内容：注入物 vs 真正的提问。
 * 两种形态都兜住——
 *  - 独立 plugin 事件：压根不会被 projectTurn 选中（source.kind !== 'user'），这层不参与；
 *  - 重写进真实用户消息：形如 `[注入块, ...原 content]`（注入在前），故只剥离"开头连续"的注入块，
 *    避免把维护者自己引用注入文案的那部分也误删。
 */
export function splitInjected(content) {
  const blocks = Array.isArray(content) ? content : []
  let i = 0
  while (i < blocks.length && isInjectionBlock(blocks[i])) i += 1
  return { injected: blocks.slice(0, i), real: blocks.slice(i) }
}

/**
 * 内容块 → 文本。
 * @param options.includeReasoning 是否带上 reasoning（抽取输入必须 false，指南明令排除）
 * @param options.placeholders 是否用 ⟨type⟩ 标注图片等非文本块
 */
export function textOfBlocks(content, options = {}) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      const text = String(block.text ?? '').trim()
      if (text) parts.push(text)
    } else if (block.type === 'reasoning') {
      if (options.includeReasoning) {
        const text = String(block.text ?? '').trim()
        if (text) parts.push(text)
      }
    } else if (block.type === 'tool-call' || block.type === 'tool-result') {
      // 工具轨迹不是对话内容：它既不该进抽取输入，也不该被当成"可见回答"。
      // （否则一条只有 tool-call 的 assistant/message 会被判为"已作答"。）
      continue
    } else if (options.placeholders !== false) {
      parts.push(`⟨${block.type}⟩`)
    }
  }
  return parts.join('\n').trim()
}

/** 真实用户轮起点（plugin 注入的 user/message 不算）。 */
export function isRealUserTurn(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/** 助手回答是否有可见文本（只有工具调用/空内容的不算"已作答"）。 */
export function hasVisibleAnswer(event) {
  if (event?.type !== 'assistant/message') return false
  return textOfBlocks(event.data?.message?.content).length > 0
}

/**
 * 从事件数组里逐轮扫描，返回每一轮的端点。
 * @param options.sinceSeq 只看这个 seq 之后的（增量抽取用；上一轮已入库的不用重算）
 * @returns [{ turnIndex, userSeq, answerSeq, complete }]
 */
export function collectTurnEndpoints(events, options = {}) {
  const since = Number.isInteger(options.sinceSeq) ? options.sinceSeq : -1
  const turns = []
  let current = null
  for (const event of events) {
    if (isRealUserTurn(event)) {
      if (current && current.userSeq > since) turns.push({ ...current, complete: false })
      current = { turnIndex: null, userSeq: event.seq, answerSeq: null, complete: false }
      continue
    }
    if (current && hasVisibleAnswer(event)) current.answerSeq = event.seq
  }
  if (current && current.userSeq > since) turns.push({ ...current, complete: false })
  let index = 0
  return turns.map((turn) => {
    const complete = Number.isInteger(turn.answerSeq)
    return { turnIndex: index++, userSeq: turn.userSeq, answerSeq: turn.answerSeq, complete }
  })
}

/**
 * 投影一轮：user question（剥离注入）+ final visible answer（排除 reasoning）。
 * @returns null（该轮未完成或缺内容）或投影对象
 */
export function projectTurn(events, userSeq, answerSeq, options = {}) {
  const userEvent = events[userSeq]
  const answerEvent = events[answerSeq]
  if (!isRealUserTurn(userEvent)) {
    throw new TypeError(`seq ${userSeq} 不是真实用户轮起点（type=${userEvent?.type}）`)
  }
  if (answerEvent?.type !== 'assistant/message') {
    throw new TypeError(`seq ${answerSeq} 不是助手回答（type=${answerEvent?.type}）`)
  }
  const { injected, real } = splitInjected(userEvent.data?.content)
  const userText = textOfBlocks(real)
  const answerText = textOfBlocks(answerEvent.data?.message?.content) // reasoning 不进抽取输入
  if (!userText) return null
  if (!answerText) return null
  return {
    sessionId: options.sessionId ?? null,
    turnIndex: Number.isInteger(options.turnIndex) ? options.turnIndex : 0,
    userSeq,
    answerSeq,
    userText,
    answerText,
    injectedBlocks: injected.length,
    injectedChars: injected.reduce((sum, b) => sum + String(b.text ?? '').length, 0),
  }
}

/** 一次性投影所有已完成轮（跳过未完成轮）。 */
export function projectCompletedTurns(events, options = {}) {
  const out = []
  for (const endpoint of collectTurnEndpoints(events, options)) {
    if (!endpoint.complete) continue
    const projected = projectTurn(events, endpoint.userSeq, endpoint.answerSeq, {
      sessionId: options.sessionId,
      turnIndex: endpoint.turnIndex,
    })
    if (projected) out.push(projected)
  }
  return out
}
