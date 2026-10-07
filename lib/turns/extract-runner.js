/**
 * extract-runner —— 把宿主的流式输出收敛成一次抽取结果（⑥ 的核心逻辑）
 *
 * 宿主侧的现实（2026-09-23 实测）：`ctx.llm.stream()` 返回 `AsyncIterable<StreamChunk>`，
 * 而 deepseek-flash 是**思考模式**，不支持强制 `tool_choice`——所以工具调用只是"建议"。
 * 因此这里必须同时接住两条路：
 *   1. 模型走了工具 → 从 `tool-call-delta` 累加 / 或直接取 `block-end` 的完整 tool-call block；
 *   2. 模型没走工具、直接在正文里吐了 JSON → 剥掉 ```json 围栏后同样交给合同解析器。
 *
 * 错误信息**不回显模型原文**（抽取输出可能含私人对话事实），只报路径与原因。
 * 本模块不依赖宿主：`stream` 由调用方注入，便于用假流做离线自测。
 */
import { parseExtraction, EXTRACTION_TOOL_NAME } from './extract-contract.js'

/** 剥掉 ```json … ``` 围栏（模型有时会把 JSON 包在代码块里）。 */
export function stripCodeFence(text) {
  const t = String(text ?? '').trim()
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  return fenced ? fenced[1].trim() : t
}

/**
 * 收集一条流：文本、工具调用、用量、结束原因。
 * 同名 block 的 `block-end` 若给出更完整的 tool-call，则以它为准。
 */
export async function collectStream(chunks) {
  const toolCalls = new Map()
  let text = ''
  let reasoning = ''
  let usage = null
  let finishReason = null
  for await (const chunk of chunks ?? []) {
    if (!chunk || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text ?? ''
        break
      case 'reasoning-delta':
        reasoning += chunk.text ?? ''
        break
      case 'tool-call-delta': {
        const current = toolCalls.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' }
        if (chunk.name) current.name = chunk.name
        current.arguments += chunk.argumentsDelta ?? ''
        toolCalls.set(chunk.id, current)
        break
      }
      case 'block-end': {
        const block = chunk.block
        if (block && block.type === 'tool-call') {
          toolCalls.set(block.id, { id: block.id, name: block.name ?? '', arguments: String(block.arguments ?? '') })
        }
        break
      }
      case 'usage':
        usage = chunk.usage ?? usage
        break
      case 'finish':
        finishReason = chunk.reason?.kind ?? chunk.reason ?? finishReason
        break
      default:
        break
    }
  }
  return { toolCalls: [...toolCalls.values()], text, reasoning, usage, finishReason }
}

/** 从收集结果里挑出"应当被解析的那段原始文本"。 */
export function pickExtractionRaw(collected, toolName = EXTRACTION_TOOL_NAME) {
  const calls = collected?.toolCalls ?? []
  const preferred = calls.find((c) => c.name === toolName) ?? calls[0]
  if (preferred && String(preferred.arguments ?? '').trim()) {
    return { raw: String(preferred.arguments), via: 'tool' }
  }
  const text = String(collected?.text ?? '').trim()
  if (text) return { raw: stripCodeFence(text), via: 'content' }
  return null
}

/**
 * 跑一次抽取：喂流 → 收集 → 挑文本 → 合同解析。
 * @param stream (messages) => AsyncIterable<StreamChunk>
 * @returns { ok, via?, result?, usage?, error? }
 */
export async function runExtraction(input) {
  const { stream, messages, toolName = EXTRACTION_TOOL_NAME } = input ?? {}
  if (typeof stream !== 'function') throw new TypeError('runExtraction: 需要注入 stream 函数')
  let collected
  try {
    collected = await collectStream(stream(messages))
  } catch (error) {
    return { ok: false, usage: null, error: `流式调用失败：${(error && error.message) || error}` }
  }
  const picked = pickExtractionRaw(collected, toolName)
  if (!picked) {
    return {
      ok: false,
      usage: collected.usage,
      error: `模型既没调用工具也没给出正文（finish_reason=${collected.finishReason ?? '未知'}）`,
    }
  }
  try {
    return { ok: true, via: picked.via, result: parseExtraction(picked.raw), usage: collected.usage }
  } catch (error) {
    return { ok: false, via: picked.via, usage: collected.usage, error: `合同校验失败（${picked.via}）：${error.message}` }
  }
}

/** 便于自测与脚本：把普通字符串包成一个最小 chunk 流。 */
export function streamOf(chunks) {
  return async function* stream() {
    for (const chunk of chunks) yield chunk
  }
}
