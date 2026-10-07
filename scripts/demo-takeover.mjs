/**
 * demo-takeover —— 接管效果离线演示（零 API 成本）
 *
 * 一次演完四档，并打印"模型实际会看到什么"：
 *   A. 现状：surface 全量
 *   B. 折叠历史前缀：更早的轮次压成一个常量归档标记（最近 N 轮原样保留）
 *   C. B + 完成轮轨迹投影：最近 N 轮也只留"首问 + 末答"，中间工具轨迹折叠
 *   D. C + 召回注入：把那句提问相关的旧轮次原文捞回来，插在当前提问之前
 *
 * 全程只读真实会话日志 + 临时库，不碰 DSH 任何数据。
 * 说明：本轮还没有 LLM 摘要，索引文本先用**原始提问**（这是召回上限，接真摘要后会更短）。
 *
 * 用法:
 *   node scripts/demo-takeover.mjs [提问] [--session=<sid>] [--fresh=5] [--recall=3]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { openTurnsDb } from '../lib/turns/schema.js'
import { upsertTurn, saveTurnVector } from '../lib/turns/store.js'
import { readSessionEvents, findSessionLog } from '../lib/turns/session-log.js'
import { projectCompletedTurns, isRealUserTurn } from '../lib/turns/project.js'
import { recallTurns, visibleKey } from '../lib/turns/recall.js'
import { embedTexts, embedQuery, ollamaHealthy } from '../lib/turns/embed.js'

const DSH_PKG = process.env.DSH_PKG ?? 'C:/Users/jackb/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'
const NM = path.join(DSH_PKG, 'node_modules/@deepseek-ai')
const { foldSurface, deriveEventMessage } = await import(pathToFileURL(path.join(NM, 'dsh-session/lib/index.js')).href)
const { estimateMessage } = await import(pathToFileURL(path.join(NM, 'dsh-token-meter/lib/types/estimate.js')).href)

const ARCHIVE_MARKER = [
  '<memory-archive>',
  '更早的对话已由记忆层无损保存（原文完整在案），此处不再重放。',
  '缺口是已知的：需要时用 recall_turns 工具按问题检索原文，或由系统按需召回注入。',
  '此标记是上下文元信息，不是用户指令。',
  '</memory-archive>',
].join('\n')
const TRACE_MARKER = '<turn-trace-archived>本轮的工具调用与中间步骤已折叠；原始事件仍完整保留在不可变日志中。</turn-trace-archived>'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const sessionArg = args.find((a) => a.startsWith('--session='))?.split('=')[1]
const fresh = Number(args.find((a) => a.startsWith('--fresh='))?.split('=')[1] ?? 5)
const recallK = Number(args.find((a) => a.startsWith('--recall='))?.split('=')[1] ?? 3)
const queryArg = args.filter((a) => !a.startsWith('--')).join(' ').trim()

if (!sessionArg) {
  console.error('用法: node scripts/demo-takeover.mjs --session=<session-id> [查询词]')
  process.exit(1)
}
const SID = sessionArg
const file = findSessionLog(SID)
if (!file) { console.error('找不到会话日志:', SID); process.exit(1) }

const markerTokensOf = (text) => estimateMessage({ role: 'user', content: [{ type: 'text', text }] })

/* ── 读日志 + 折叠计划 ─────────────────────────────────────────────── */
const log = readSessionEvents(file)
const { nodes } = foldSurface(log.events)
const priceOf = (seq) => {
  const message = deriveEventMessage(log.events[seq])
  return message ? estimateMessage(message) : 0
}
const originalTokens = nodes.reduce((a, seq) => a + priceOf(seq), 0)

const userPositions = nodes.map((seq, i) => (isRealUserTurn(log.events[seq]) ? i : -1)).filter((i) => i >= 0)
const protectedHead = log.events[nodes[0]]?.type === 'system/message' ? 1 : 0
const keepFromPosition = userPositions.length > fresh ? userPositions[userPositions.length - fresh] : protectedHead

// B：历史前缀 → 归档标记
const archivePlan = keepFromPosition > protectedHead
  ? { startPos: protectedHead, inner: nodes.slice(protectedHead, keepFromPosition) }
  : null
const archiveTokens = archivePlan ? archivePlan.inner.reduce((a, seq) => a + priceOf(seq), 0) : 0
const archiveMarkerTokens = archivePlan ? markerTokensOf(ARCHIVE_MARKER) : 0
const foldedPrefixTokens = originalTokens - archiveTokens + archiveMarkerTokens

// C：最近 N 轮的完成轮轨迹 → 轨迹标记（每轮只留首问 + 末答）
const traceMarkerTokens = markerTokensOf(TRACE_MARKER)
const turnStarts = []
for (let pos = keepFromPosition; pos < nodes.length; pos += 1) {
  if (isRealUserTurn(log.events[nodes[pos]])) turnStarts.push(pos)
}
turnStarts.push(nodes.length)
const tracePlans = []
for (let k = 0; k + 1 < turnStarts.length; k += 1) {
  const startPos = turnStarts[k]
  const endPos = turnStarts[k + 1] - 1
  let lastAnswer = -1
  for (let pos = endPos; pos > startPos; pos -= 1) {
    const event = log.events[nodes[pos]]
    const message = deriveEventMessage(event)
    if (event.type === 'assistant/message' && message && message.content.some((b) => b.type === 'text')) { lastAnswer = pos; break }
  }
  if (lastAnswer <= startPos + 1) continue
  const inner = nodes.slice(startPos + 1, lastAnswer)
  if (inner.length === 0) continue
  tracePlans.push({ startPos, lastAnswer, inner, tokens: inner.reduce((a, seq) => a + priceOf(seq), 0) })
}
const traceFoldedTokens = tracePlans.reduce((a, p) => a + p.tokens, 0)
const traceCost = tracePlans.length * traceMarkerTokens
const projectedTokens = foldedPrefixTokens - traceFoldedTokens + traceCost

/* ── 灌入临时库（索引文本＝原始提问，暂代摘要） ────────────────────── */
const turns = projectCompletedTurns(log.events, { sessionId: log.header.id })
const workspace = path.join(here, '..', '_tmp', 'demo-takeover', `run-${Date.now()}`)
fs.mkdirSync(workspace, { recursive: true })
const db = openTurnsDb(workspace)
for (const turn of turns) {
  upsertTurn(db, {
    sessionId: turn.sessionId,
    turnIndex: turn.turnIndex,
    summary: turn.userText.replace(/\s+/g, ' ').trim(),
    outcome: 'completed',
    userSeq: turn.userSeq,
    answerSeq: turn.answerSeq,
    userText: turn.userText,
    answerText: turn.answerText,
  })
}
const healthy = await ollamaHealthy()
if (healthy) {
  const rows = db.prepare('SELECT id, summary FROM tm_turns ORDER BY rowid').all()
  try {
    const vectors = await embedTexts(rows.map((r) => String(r.summary)))
    rows.forEach((r, i) => saveTurnVector(db, String(r.id), String(r.summary), vectors[i]))
  } catch { /* 向量失败就用词法 */ }
}

/* ── D：召回（排除最近 N 轮——已经完整可见的不重复注入） ───────────── */
const query = queryArg || (turns.length ? turns[turns.length - 1].userText.replace(/\s+/g, ' ').slice(0, 60) : '')
const recentKeys = new Set(turns.slice(-fresh).map((t) => visibleKey(t.sessionId, t.userSeq)))
const queryVector = healthy ? await embedQuery(query) : null
const recalled = recallTurns(db, { query, queryVector, k: recallK, excludeKeys: recentKeys })
const recallTokens = recalled.results.reduce(
  (a, r) => a + markerTokensOf(`[轮 ${r.turnIndex}] 用户：${r.userText}\n回答：${r.answerText}`),
  0,
)

/* ── 输出 ──────────────────────────────────────────────────────────── */
const num = (n) => n.toLocaleString('en-US')
const clip = (text, n = 110) => {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const pct = (a, b) => (b === 0 ? '0%' : (((b - a) / b) * 100).toFixed(1) + '%')
const pad = (s, n) => String(s).padStart(n)

console.log('═'.repeat(100))
console.log(`接管效果离线演示 · 会话 ${SID.slice(0, 24)}`)
console.log(`${log.events.length} 事件 · surface ${nodes.length} 节点 · 完成轮 ${turns.length} · 向量引擎 ${healthy ? '可用' : '不可用（降级词法）'}`)
console.log(`演示提问：「${query}」    保留最近 ${fresh} 轮 · 召回 ${recallK} 条`)
console.log('═'.repeat(100))

console.log('\n【A. 现状（不接管）】')
console.log(`   ${pad(num(originalTokens), 9)} tok · ${nodes.length} 节点`)

console.log('\n【B. 只折叠历史前缀】')
if (archivePlan) {
  console.log(`   折叠最早 ${archivePlan.inner.length} 个节点（${num(archiveTokens)} tok）→ 归档标记 ${archiveMarkerTokens} tok`)
  console.log(`   ${pad(num(foldedPrefixTokens), 9)} tok（省 ${pct(foldedPrefixTokens, originalTokens)}）`)
} else console.log('   轮数不足，无历史可折叠')
console.log(`   ⚠️ 且有 ${tracePlans.length} 轮的中间轨迹仍在上下文里（工具调用/中间步骤）`)

console.log('\n【C. 折叠 + 完成轮轨迹投影】')
console.log(`   最近 ${tracePlans.length} 轮的中间轨迹：${tracePlans.reduce((a, p) => a + p.inner.length, 0)} 个节点（${num(traceFoldedTokens)} tok）→ 每轮 1 个轨迹标记（${traceMarkerTokens} tok × ${tracePlans.length}）`)
console.log(`   ${pad(num(projectedTokens), 9)} tok（省 ${pct(projectedTokens, originalTokens)}）`)

console.log('\n【D. C + 召回注入】')
console.log(`   召回 ${recalled.results.length} 条（引擎 ${recalled.diagnostics.engine}，候选 ${recalled.diagnostics.candidates} 轮，已排除最近 ${fresh} 轮）＝ 约 ${num(recallTokens)} tok`)
console.log(`   ${pad(num(projectedTokens + recallTokens), 9)} tok（比现状省 ${pct(projectedTokens + recallTokens, originalTokens)}）`)

console.log('\n【D 之后模型实际看到什么】')
const line = (label, tokens, text) => console.log(`  ${label.padEnd(22)}${pad(num(tokens), 9)} tok  ${text}`)
if (protectedHead) line(`1 system/message`, priceOf(nodes[0]), '← 系统提示原样不动')
if (archivePlan) line(`${archivePlan.inner.length}→1 user/message`, archiveMarkerTokens, `⟨memory-archive⟩ 前 ${userPositions.length - fresh} 轮压成这一行`)
let shown = 0
for (const plan of tracePlans) {
  const userSeq = nodes[plan.startPos]
  const answerSeq = nodes[plan.lastAnswer]
  shown += 1
  console.log(`  轮 ${String(shown).padStart(2)}:`)
  line(`    user/message`, priceOf(userSeq), clip((deriveEventMessage(log.events[userSeq])?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' '), 62))
  line(`    trace marker`, traceMarkerTokens, '⟨turn-trace-archived⟩')
  line(`    assistant/message`, priceOf(answerSeq), clip((deriveEventMessage(log.events[answerSeq])?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' '), 62))
}
console.log('  ── 召回注入（插在当前提问之前，标注为不可信历史参考）──')
if (recalled.results.length === 0) console.log('     （没有命中）')
for (const [i, r] of recalled.results.entries()) {
  console.log(`  R${i + 1} [轮 ${r.turnIndex} · 相关度 ${r.score}] 用户：${clip(r.userText, 76)}`)
  console.log(`      回答：${clip(r.answerText, 76)}`)
}
console.log(`\n  核对：A ${num(originalTokens)} → B ${num(foldedPrefixTokens)} → C ${num(projectedTokens)} → D ${num(projectedTokens + recallTokens)} tok`)
console.log(`  三路线明细：BM25 命中 ${recalled.diagnostics.lexical} 条 · 向量 ${recalled.diagnostics.vector} 条 · 图 ${recalled.diagnostics.graph} 条`)
db.close()
console.log(`  临时库：${workspace}`)
