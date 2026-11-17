/**
 * facts-build —— 事实索引的构建核心（2026-11-19）
 *
 * 放在 `lib/` 而不是 `scripts/`：**发布包只含 lib**（见 package.json 的 files），
 * 而设置页的一键构建必须在发布包里也能跑。`scripts/build-facts.mjs` 只是它的 CLI 外壳。
 *
 * 三条安全约定：
 *  1. 只读 `memory.db`，只写 `.dsh-semantic/facts.json`（原子写）；
 *  2. 增量：记忆的 `updated_at` 与索引里的 `srcUpdatedAt` 一致就跳过，不重复花钱；
 *  3. 单条失败只记账——**旧数据保留**，绝不因为抽取失败把索引清空。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FACTS_TOOL, buildFactsMessages, parseFacts } from './facts-contract.js'

const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
const DEFAULT_BASE = process.env.DEEPSEEK_BASE ?? 'https://api.deepseek.com'
const DEFAULT_MODEL = process.env.SAMPLE_MODEL ?? 'deepseek-flash'
const DEFAULT_EFFORT = process.env.SAMPLE_EFFORT ?? 'minimal'

export function factsPathOf(workspace) {
  return path.join(workspace, '.dsh-semantic', 'facts.json')
}

/** 读 API key：环境变量优先，其次 `~/.dsh/deepseek-api.key`。 */
export function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return String(process.env.DEEPSEEK_API_KEY).trim()
  const file = path.join(os.homedir(), '.dsh', 'deepseek-api.key')
  return fs.readFileSync(file, 'utf8').trim()
}

function stripCodeFence(text) {
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

/** 单条记忆抽一次（带一次重试）。 */
async function extractFactsOfRecord(key, record, options = {}) {
  const base = options.base ?? DEFAULT_BASE
  const model = options.model ?? DEFAULT_MODEL
  const effort = options.effort ?? DEFAULT_EFFORT
  const messages = buildFactsMessages(record)
  let last = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const json = await callCompletion(key, {
        model,
        messages,
        tools: [{ type: 'function', function: FACTS_TOOL.function ?? FACTS_TOOL }],
        temperature: 0,
        max_tokens: 2000,
        ...(effort ? { reasoning_effort: effort } : {}),
      }, base)
      const message = json.choices?.[0]?.message ?? {}
      const call = message.tool_calls?.[0]
      const raw = call ? String(call.function?.arguments ?? '') : stripCodeFence(message.content ?? '')
      const usage = json.usage ?? {}
      if (!raw) { last = { ok: false, usage, error: '模型没给内容' }; continue }
      const parsed = parseFacts(raw, record)
      return { ok: parsed.ok, triples: parsed.triples, usage, error: parsed.error }
    } catch (error) {
      last = { ok: false, usage: {}, error: String((error && error.message) || error) }
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return last || { ok: false, triples: [], usage: {}, error: 'unknown' }
}

/** 读所有 active 记忆（只读）。 */
export function readMemoryRecords(workspace) {
  const memPath = path.join(workspace, '.dsh-meow', 'memory.db')
  if (!fs.existsSync(memPath)) throw new Error(`找不到记忆库：${memPath}`)
  const db = new DatabaseSync(memPath, { readOnly: true })
  const out = []
  try {
    for (const t of LEVELS) {
      let rows = []
      try {
        rows = db.prepare(`SELECT id, content, project, updated_at FROM ${t} WHERE COALESCE(status,'active') != 'archived'`).all()
      } catch { continue }
      for (const r of rows) {
        const content = String(r.content || '')
        if (content.length < 20) continue
        out.push({
          id: String(r.id), level: t, project: String(r.project || ''),
          updated_at: Number(r.updated_at) || 0, content,
        })
      }
    }
  } finally { try { db.close() } catch { /* 已关 */ } }
  return out
}

/** 读现有 facts.json（不存在就空）。 */
export function readFactsIndex(workspace) {
  try {
    const j = JSON.parse(fs.readFileSync(factsPathOf(workspace), 'utf8'))
    return (j && typeof j === 'object' && Array.isArray(j.triples)) ? j : { version: 1, triples: [] }
  } catch { return { version: 1, triples: [] } }
}

/**
 * 算"要抽多少"（不花钱）。设置页预览与 CLI 的 --dry 都用它。
 */
export function planFactsBuild(workspace, { force = false } = {}) {
  const memories = readMemoryRecords(workspace)
  const existing = readFactsIndex(workspace)
  const done = new Map()
  // scanned 是权威（2026-11-19 加）：抽成功但**抽出 0 条**的记忆也要算"扫过"，
  // 否则它永远待抽（只靠 triples 反推的话，0 条的条目没有任何痕迹）。
  for (const [id, at] of Object.entries(existing.scanned || {})) done.set(String(id), Number(at))
  for (const t of existing.triples || []) {
    if (!t || !t.src) continue
    const prev = done.get(t.src)
    if (prev === undefined || Number(t.srcUpdatedAt) > prev) done.set(t.src, Number(t.srcUpdatedAt))
  }
  const todo = memories.filter((m) => force || done.get(m.id) !== m.updated_at)
  return {
    memories: memories.length,
    indexedTriples: (existing.triples || []).length,
    todo: todo.length,
    unchanged: memories.length - todo.length,
    inputChars: todo.reduce((sum, m) => sum + Math.min(m.content.length, 3000), 0),
    records: todo,
    existing,
  }
}

/**
 * 真跑构建。
 * @param {{workspace:string, key?:string, force?:boolean, limit?:number, concurrency?:number, onProgress?:(p:object)=>void}} options
 * @returns {Promise<{ok:boolean, replaced:number, failed:number, triples:number, tokenIn:number, tokenOut:number, error?:string}>}
 */
export async function buildFactsIndex(options = {}) {
  const { workspace } = options
  if (!workspace) throw new Error('buildFactsIndex: 需要 workspace')
  const force = options.force === true
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4))
  const plan = planFactsBuild(workspace, { force })
  let todo = plan.records
  if (Number(options.limit) > 0) todo = todo.slice(0, Number(options.limit))
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  if (todo.length === 0) {
    return { ok: true, replaced: 0, failed: 0, triples: plan.indexedTriples, tokenIn: 0, tokenOut: 0 }
  }
  const key = options.key || loadApiKey()
  const results = []
  let cursor = 0
  let okCount = 0
  let failCount = 0
  let tokenIn = 0
  let tokenOut = 0
  const started = Date.now()

  const worker = async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= todo.length) return
      const m = todo[i]
      const r = await extractFactsOfRecord(key, m, { model: options.model, effort: options.effort })
      const usage = r.usage || {}
      tokenIn += Number(usage.prompt_tokens) || 0
      tokenOut += Number(usage.completion_tokens) || 0
      const okFlag = r.ok === true
      if (okFlag) okCount += 1; else failCount += 1
      results.push({
        id: m.id, level: m.level, project: m.project, updated_at: m.updated_at,
        triples: okFlag ? r.triples : [], error: okFlag ? '' : (r.error || 'unknown'),
      })
      if (onProgress) {
        try {
          onProgress({
            total: todo.length, done: i + 1, ok: okCount, failed: failCount,
            elapsedMs: Date.now() - started, tokenIn, tokenOut,
          })
        } catch { /* 进度回调失败不影响构建 */ }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  // 合并：成功替换、失败/未抽保留旧数据
  const bySrc = new Map()
  for (const t of plan.existing.triples || []) {
    if (!t || !t.src) continue
    if (!bySrc.has(t.src)) bySrc.set(t.src, [])
    bySrc.get(t.src).push(t)
  }
  let replaced = 0
  for (const r of results) {
    if (r.error) continue
    replaced += 1
    bySrc.set(r.id, r.triples.map((t) => ({
      src: r.id, level: r.level, project: r.project, updated_at: r.updated_at,
      subject: t.subject, predicate: t.predicate, value: t.value,
      category: t.category, srcUpdatedAt: r.updated_at,
    })))
  }
  const triples = []
  for (const list of bySrc.values()) for (const t of list) triples.push(t)
  // scanned：所有**抽成功**的记忆（含抽出 0 条的）→ 其 updated_at
  const scanned = { ...(plan.existing.scanned || {}) }
  for (const r of results) if (!r.error) scanned[r.id] = r.updated_at
  const out = { version: 2, updatedAt: new Date().toISOString(), count: triples.length, triples, scanned }

  fs.mkdirSync(path.dirname(factsPathOf(workspace)), { recursive: true })
  const tmp = `${factsPathOf(workspace)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(out))
  fs.renameSync(tmp, factsPathOf(workspace))

  return {
    ok: true, replaced, failed: failCount, triples: out.count,
    tokenIn, tokenOut, countBefore: plan.indexedTriples,
  }
}
