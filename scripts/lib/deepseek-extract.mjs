/**
 * deepseek-extract —— 脚本用的抽取调用（HTTP 直连 deepseek-flash）
 *
 * 注意：插件正式运行时走的是宿主 `ctx.llm.stream`；这里是**离线脚本**用的等价实现，
 * 供 sample-extract / backfill-turns 这类验证与回填工具使用。
 *
 * 实测要点（2026-09-23）：
 *  - deepseek-flash 是**思考模式**，带 tool_choice 会被拒（400 "Thinking mode does not support this tool_choice"）
 *    → 只给 tools（auto），并把"模型直接吐 JSON 正文"也一并接住；
 *  - reasoning_effort='minimal' 显著压缩思考开销，否则 reasoning 会吃光输出预算被截断；
 *  - 不支持的参数自动去掉重试一次。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseExtraction, EXTRACTION_TOOL } from '../../lib/turns/extract-contract.js'

export const DEFAULT_BASE = process.env.DEEPSEEK_BASE ?? 'https://api.deepseek.com'
export const DEFAULT_MODEL = process.env.SAMPLE_MODEL ?? 'deepseek-flash'
export const DEFAULT_EFFORT = process.env.SAMPLE_EFFORT ?? 'minimal'
export const DEFAULT_MAX_TOKENS = Number(process.env.SAMPLE_MAX_TOKENS ?? 4000)

export function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const file = path.join(os.homedir(), '.dsh', 'deepseek-api.key')
  return fs.readFileSync(file, 'utf8').trim()
}

export function stripCodeFence(text) {
  const t = String(text ?? '').trim()
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  return fenced ? fenced[1].trim() : t
}

async function callCompletion(key, body, base) {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    const text = await response.text()
    if (response.status === 400 && body.reasoning_effort && /reasoning_effort|reasoning effort|thinking/i.test(text)) {
      const { reasoning_effort, ...rest } = body
      void reasoning_effort
      return callCompletion(key, rest, base)
    }
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

/**
 * 跑一次结构化抽取。
 * @returns { ok, via, result, usage, error }
 */
export async function extractOnce(key, messages, options = {}) {
  const base = options.base ?? DEFAULT_BASE
  const model = options.model ?? DEFAULT_MODEL
  const effort = options.effort ?? DEFAULT_EFFORT
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const json = await callCompletion(key, {
    model,
    messages,
    tools: [{ type: 'function', function: EXTRACTION_TOOL }],
    temperature: 0,
    max_tokens: maxTokens,
    ...(effort ? { reasoning_effort: effort } : {}),
  }, base)
  const usage = json.usage ?? {}
  const message = json.choices?.[0]?.message ?? {}
  const call = message.tool_calls?.[0]
  const raw = call ? String(call.function?.arguments ?? '') : stripCodeFence(message.content ?? '')
  const via = call ? 'tool' : 'content'
  if (!raw) {
    return { ok: false, usage, error: `既没调用工具也没给正文（finish_reason=${json.choices?.[0]?.finish_reason}）` }
  }
  try {
    return { ok: true, via, result: parseExtraction(raw), usage }
  } catch (error) {
    return { ok: false, via, usage, error: `合同校验失败（${via}）：${error.message}` }
  }
}

/** 带重试的抽取（网络抖动不浪费已花的时间）。 */
export async function extractWithRetry(key, messages, options = {}) {
  const attempts = options.attempts ?? 2
  let last
  for (let i = 1; i <= attempts; i += 1) {
    try {
      last = await extractOnce(key, messages, options)
      if (last.ok) return last
    } catch (error) {
      last = { ok: false, usage: {}, error: error.message }
    }
    if (i < attempts) await new Promise((resolve) => setTimeout(resolve, 800 * i))
  }
  return last
}
