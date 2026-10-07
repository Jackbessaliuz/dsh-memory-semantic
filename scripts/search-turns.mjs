/**
 * search-turns —— 在真实轮次记忆库上检索（手动演示 / 自检工具）
 *
 * 用法:
 *   node scripts/search-turns.mjs "查询文本" [--k=3] [--workspace=<工作区路径，缺省取当前目录>]
 *
 * 只读打开库；不与 DSH 交互。将来插件里的自动召回走的是同一套 recallTurns，
 * 所以这里的结果就是"接管之后模型能拿回什么"的实况。
 */
import path from 'node:path'
import { openTurnsDb, turnsDbPathOf } from '../lib/turns/schema.js'
import { recallTurns } from '../lib/turns/recall.js'
import { embedQuery, ollamaHealthy } from '../lib/turns/embed.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const query = args.filter((a) => !a.startsWith('--')).join(' ').trim()
const k = Number(argOf('k', 3))
const workspace = argOf('workspace', process.cwd())

if (!query) { console.error('用法: node scripts/search-turns.mjs "查询" [--k=3]'); process.exit(2) }

const db = openTurnsDb(workspace, { readOnly: true })
const totals = db.prepare('SELECT COUNT(*) AS turns, COUNT(DISTINCT session_id) AS sessions FROM tm_turns').get()
const healthy = await ollamaHealthy()
const queryVector = healthy ? await embedQuery(query) : null
const started = Date.now()
const result = recallTurns(db, { query, queryVector, k })
const elapsed = Date.now() - started

const clip = (text, n) => {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

console.log(`库：${totals.turns} 轮 / ${totals.sessions} 会话  ·  ${turnsDbPathOf(workspace)}`)
console.log(`查询：「${query}」  引擎 ${result.diagnostics.engine}（BM25 ${result.diagnostics.lexical} · 向量 ${result.diagnostics.vector} · 图 ${result.diagnostics.graph}）  ${elapsed}ms`)
console.log('─'.repeat(96))
for (const [i, r] of result.results.entries()) {
  console.log(`#${i + 1} [轮 ${r.turnIndex} · ${r.sessionId.slice(0, 20)} · 相关度 ${r.score}${r.routes.length ? ' · ' + r.routes.join('+') : ''}]`)
  console.log(`    摘要：${clip(r.summary, 150)}`)
  console.log(`    原文 · 问：${clip(r.userText, 150)}`)
  console.log(`    原文 · 答：${clip(r.answerText, 150)}`)
  if (r.triples.length) console.log(`    SPO：${r.triples.slice(0, 3).map((t) => `${t.subject} —${t.predicate}→ ${t.object}`).join(' | ')}`)
}
if (result.results.length === 0) console.log('（未命中）')
db.close()
