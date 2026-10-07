/**
 * sample-extract —— 小样本真摘要抽取（唯一一处会花钱的验证）
 *
 * 拿一个真实会话的前 N 轮，逐轮调用 deepseek-flash 做一次结构化抽取
 * （tools + 强制 tool_choice），产物走我们自己的 `parseExtraction` 合同校验，
 * 然后打印摘要质量、失败原因、真实 token 消耗——用来决定"档位"与"回填范围"。
 *
 * 不写任何 DSH 数据；结果落到 _tmp/sample-extract/run-<时间戳>.json，供后续
 * "真摘要 vs 原文"的召回对比。
 *
 * 用法:
 *   node scripts/sample-extract.mjs --limit=2      # 先试两轮
 *   node scripts/sample-extract.mjs --limit=20     # 正式小样本
 * 环境变量: SAMPLE_SESSION / SAMPLE_MODEL / DEEPSEEK_API_KEY（缺省读 ~/.dsh/deepseek-api.key）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionEvents, findSessionLog } from '../lib/turns/session-log.js'
import { projectCompletedTurns } from '../lib/turns/project.js'
import { buildExtractMessages, parseExtraction, EXTRACTION_TOOL } from '../lib/turns/extract-contract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const limitArg = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 20)
const SID = process.env.SAMPLE_SESSION ?? args.find((a) => a.startsWith('session-'))
if (!SID) {
  console.error('用法: node scripts/sample-extract.mjs <session-id>  或设 SAMPLE_SESSION')
  process.exit(1)
}
const MODEL = process.env.SAMPLE_MODEL ?? 'deepseek-flash'
const BASE = process.env.DEEPSEEK_BASE ?? 'https://api.deepseek.com'
/** 思考模式默认会先花掉大量 reasoning token（实测首轮 1200 输出全用在思考上并被截断）；
 *  压缩思考强度能显著降低成本与截断率。不支持的模型会自动去掉该参数重试。 */
const EFFORT = process.env.SAMPLE_EFFORT ?? 'minimal'
const MAX_TOKENS = Number(process.env.SAMPLE_MAX_TOKENS ?? 4000)

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const file = path.join(os.homedir(), '.dsh', 'deepseek-api.key')
  return fs.readFileSync(file, 'utf8').trim()
}

/**
 * 一次抽取调用。
 *
 * ⚠️ 实测教训（2026-09-23）：deepseek-flash 是**思考模式**，带 `tool_choice` 会被拒：
 *    HTTP 400 "Thinking mode does not support this tool_choice"
 * 这正印证上游那句注释——DSH 的 ToolSchema 是**建议性**的，不能强制。
 * 所以这里只给 tools（auto），并额外接住"模型没走工具、但直接吐了合法 JSON"的情况；
 * 两条路都走我们自己的 parseExtraction 合同校验，且记录来源便于统计遵守率。
 */
function stripCodeFence(text) {
  const t = String(text).trim()
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  return fenced ? fenced[1].trim() : t
}

async function callCompletion(key, body) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    const text = await response.text()
    // 模型不支持 reasoning_effort 时自动回退（去掉该字段重试一次）
    if (response.status === 400 && body.reasoning_effort && /reasoning_effort|reasoning effort|thinking/i.test(text)) {
      const { reasoning_effort, ...rest } = body
      void reasoning_effort
      return callCompletion(key, rest)
    }
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function extractOnce(key, messages) {
  const json = await callCompletion(key, {
    model: MODEL,
    messages,
    tools: [{ type: 'function', function: EXTRACTION_TOOL }],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    ...(EFFORT ? { reasoning_effort: EFFORT } : {}),
  })
  const usage = json.usage ?? {}
  const message = json.choices?.[0]?.message ?? {}
  const call = message.tool_calls?.[0]
  const raw = call ? String(call.function?.arguments ?? '') : stripCodeFence(message.content ?? '')
  const via = call ? 'tool' : 'content'
  if (!raw) {
    return { ok: false, usage, error: `模型既没调用工具也没给正文（finish_reason=${json.choices?.[0]?.finish_reason}）` }
  }
  try {
    return { ok: true, via, result: parseExtraction(raw), usage }
  } catch (error) {
    return { ok: false, via, usage, error: `合同校验失败（${via}）：${error.message}` }
  }
}

/* ── 主流程 ────────────────────────────────────────────────────────── */
const log = readSessionEvents(findSessionLog(SID))
const all = projectCompletedTurns(log.events, { sessionId: log.header.id })
const turns = all.slice(0, Math.max(1, Math.min(limitArg, all.length)))
const key = loadKey()

console.log(`会话 ${SID.slice(0, 24)} · 完成轮 ${all.length} · 本次抽取前 ${turns.length} 轮`)
console.log(`模型 ${MODEL} · base ${BASE}`)
console.log('─'.repeat(96))

const results = []
let inTokens = 0
let outTokens = 0
let cacheHit = 0
const started = Date.now()

for (const [i, turn] of turns.entries()) {
  const prior = results.filter((r) => r.ok).slice(-3).map((r) => r.summary)
  const messages = buildExtractMessages({ userText: turn.userText, answerText: turn.answerText, priorSummaries: prior })
  let outcome
  try {
    outcome = await extractOnce(key, messages)
  } catch (error) {
    outcome = { ok: false, usage: {}, error: error.message }
  }
  inTokens += outcome.usage?.prompt_tokens ?? 0
  outTokens += outcome.usage?.completion_tokens ?? 0
  cacheHit += outcome.usage?.prompt_cache_hit_tokens ?? 0
  const record = {
    turnIndex: turn.turnIndex,
    ok: outcome.ok,
    via: outcome.via ?? null,
    error: outcome.error ?? null,
    summary: outcome.result?.summary ?? null,
    outcome: outcome.result?.outcome ?? null,
    triples: outcome.result?.triples ?? [],
    usage: outcome.usage ?? {},
    userChars: turn.userText.length,
    answerChars: turn.answerText.length,
  }
  results.push(record)
  const mark = record.ok ? '✓' : '✗'
  console.log(`${mark} 轮 ${String(record.turnIndex).padStart(2)}  ${String(record.usage.prompt_tokens ?? '-').padStart(5)}→${String(record.usage.completion_tokens ?? '-').padStart(4)} tok  ${record.ok ? `[${record.outcome}·${record.via}] ${record.summary}` : record.error}`)
  if (record.ok && record.triples.length) {
    console.log(`   SPO: ${record.triples.map((t) => `${t.subject} —${t.predicate}→ ${t.object}`).join(' | ')}`)
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const okCount = results.filter((r) => r.ok).length
const triples = results.reduce((a, r) => a + r.triples.length, 0)
const avgSummary = okCount ? Math.round(results.filter((r) => r.ok).reduce((a, r) => a + r.summary.length, 0) / okCount) : 0
const avgInputChars = Math.round(results.reduce((a, r) => a + r.userChars + r.answerChars, 0) / results.length)

console.log('─'.repeat(96))
console.log(`成功 ${okCount}/${results.length} · 失败 ${results.length - okCount}`)
console.log(`token：输入 ${inTokens.toLocaleString('en-US')}（其中缓存命中 ${cacheHit.toLocaleString('en-US')}）· 输出 ${outTokens.toLocaleString('en-US')}`)
console.log(`平均每轮：输入 ${Math.round(inTokens / results.length)} tok · 输出 ${Math.round(outTokens / results.length)} tok`)
console.log(`摘要平均 ${avgSummary} 字 · 每轮原文平均 ${avgInputChars} 字 · 耗时 ${elapsed}s`)
console.log(`外推：本次样本 ${results.length} 轮；全量 34 会话约 850 轮 → 输入约 ${Math.round((inTokens / results.length) * 850).toLocaleString('en-US')} tok、输出约 ${Math.round((outTokens / results.length) * 850).toLocaleString('en-US')} tok`)

const outDir = path.join(here, '..', '_tmp', 'sample-extract')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `run-${Date.now()}.json`)
fs.writeFileSync(outFile, JSON.stringify({ sessionId: SID, model: MODEL, turns: results, totals: { inTokens, outTokens, cacheHit } }, null, 2), 'utf8')
console.log(`结果已存：${outFile}`)
