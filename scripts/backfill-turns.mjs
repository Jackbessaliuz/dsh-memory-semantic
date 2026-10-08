/**
 * backfill-turns —— 把历史会话回填进轮次记忆库（需要调用 LLM，会产生费用）
 *
 * 做三件事：投影 → 抽取（摘要＋outcome＋SPO）→ 写库 + 算摘要向量。
 *
 * 安全与省钱设计：
 *  - **幂等**：轮次 id 由 (sessionId, userSeq, answerSeq) 决定；已入库的轮次直接跳过，
 *    重复跑不会重复花钱（--force 才重抽已有的）；
 *  - **逐轮落库**：每轮抽完立刻写，中断后重跑只补没抽过的；
 *  - **失败不阻塞**：单轮失败只记录并继续，下次重跑再补；
 *  - 只写 `<workspace>/.dsh-semantic/turns.db`（我们自己的库），不碰 DSH 任何数据。
 *
 * 用法:
 *   node scripts/backfill-turns.mjs                      # 默认：最近 3 天有活动的会话
 *   node scripts/backfill-turns.mjs --days=3
 *   node scripts/backfill-turns.mjs --session=session-xxx # 只跑一个会话
 *   node scripts/backfill-turns.mjs --sessions=1          # 最多几个会话（试跑用）
 *   node scripts/backfill-turns.mjs --dry                 # 只统计不调用模型
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openTurnsDb, turnsDbPathOf } from '../lib/turns/schema.js'
import { upsertTurn, replaceTriples, saveTurnVector } from '../lib/turns/store.js'
import { readSessionEvents } from '../lib/turns/session-log.js'
import { projectCompletedTurns } from '../lib/turns/project.js'
import { buildExtractMessages } from '../lib/turns/extract-contract.js'
import { embedTexts, ollamaHealthy } from '../lib/turns/embed.js'
import { loadKey, extractWithRetry, DEFAULT_MODEL } from './lib/deepseek-extract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const DAYS = Number(argOf('days', 3))
const WORKSPACE = argOf('workspace', process.cwd())
const ONLY = argOf('session', null)
const MAX_SESSIONS = Number(argOf('sessions', 0))
const DRY = args.includes('--dry')
const FORCE = args.includes('--force')

/** 找 <DSH_HOME>/sessions 下最近 N 天有写入的主会话（session- 前缀）。 */
function recentSessions(days, only) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const root = path.join(home, 'sessions')
  const cutoff = Date.now() - days * 86400000
  const found = []
  let buckets = []
  try { buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return found }
  for (const bucket of buckets) {
    let sids = []
    try { sids = fs.readdirSync(path.join(root, bucket.name), { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const sid of sids) {
      if (!sid.name.startsWith('session-')) continue
      if (only && sid.name !== only) continue
      let file = null
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        const p = path.join(root, bucket.name, sid.name, name)
        if (fs.existsSync(p)) { file = p; break }
      }
      if (!file) continue
      const stat = fs.statSync(file)
      if (!only && stat.mtimeMs < cutoff) continue
      found.push({ sid: sid.name, file, mtime: stat.mtimeMs, mb: stat.size / 1024 / 1024 })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

/* ── 主流程 ────────────────────────────────────────────────────────── */
const sessions = recentSessions(DAYS, ONLY)
const targets = MAX_SESSIONS > 0 ? sessions.slice(0, MAX_SESSIONS) : sessions
console.log(`工作区 ${WORKSPACE}`)
console.log(`库文件 ${turnsDbPathOf(WORKSPACE)}`)
console.log(`扫描范围：最近 ${DAYS} 天有活动的主会话 → ${sessions.length} 个${MAX_SESSIONS ? `，本次只跑前 ${targets.length} 个` : ''}`)
for (const s of targets) console.log(`  ${s.sid.slice(0, 24)}  ${s.mb.toFixed(2)}MB  ${new Date(s.mtime).toLocaleString('zh-CN', { hour12: false })}`)
if (targets.length === 0) { console.log('没有需要处理的会话'); process.exit(0) }

const db = openTurnsDb(WORKSPACE)
const key = DRY ? null : loadKey()
const vectorOk = await ollamaHealthy()
if (!DRY) console.log(`模型 ${DEFAULT_MODEL} · 向量引擎 ${vectorOk ? '可用' : '不可用（跳过向量）'}`)
console.log('─'.repeat(96))

let totalNew = 0
let totalSkipped = 0
let totalFailed = 0
let inTokens = 0
let outTokens = 0
const started = Date.now()

for (const session of targets) {
  const log = readSessionEvents(session.file)
  const projected = projectCompletedTurns(log.events, { sessionId: log.header.id })
  const existing = new Set(
    db.prepare('SELECT user_seq FROM tm_turns WHERE session_id=?').all(String(log.header.id)).map((r) => Number(r.user_seq)),
  )
  const todo = FORCE ? projected : projected.filter((t) => !existing.has(t.userSeq))
  console.log(`\n会话 ${session.sid.slice(0, 24)}  完成轮 ${projected.length}  已有 ${existing.size}  待抽 ${todo.length}`)
  const newSummaries = []
  let sessionNew = 0
  for (const turn of todo) {
    if (DRY) continue
    const prior = db.prepare('SELECT summary FROM tm_turns WHERE session_id=? ORDER BY turn_index DESC LIMIT 3')
      .all(String(log.header.id)).map((r) => String(r.summary)).reverse()
    const messages = buildExtractMessages({ userText: turn.userText, answerText: turn.answerText, priorSummaries: prior })
    const outcome = await extractWithRetry(key, messages)
    inTokens += outcome.usage?.prompt_tokens ?? 0
    outTokens += outcome.usage?.completion_tokens ?? 0
    if (!outcome.ok) {
      totalFailed += 1
      console.log(`  ✗ 轮 ${String(turn.turnIndex).padStart(2)}  ${outcome.error}`)
      continue
    }
    const record = upsertTurn(db, {
      sessionId: log.header.id,
      turnIndex: turn.turnIndex,
      summary: outcome.result.summary,
      outcome: outcome.result.outcome,
      userSeq: turn.userSeq,
      answerSeq: turn.answerSeq,
      userText: turn.userText,
      answerText: turn.answerText,
    })
    replaceTriples(db, record.id, log.header.id, outcome.result.triples)
    newSummaries.push({ id: record.id, text: String(turn.userText || outcome.result.summary) })
    sessionNew += 1
    totalNew += 1
    console.log(`  ✓ 轮 ${String(turn.turnIndex).padStart(2)}  [${outcome.result.outcome}·${outcome.via}] ${outcome.result.summary.slice(0, 52)}…  (${outcome.usage?.prompt_tokens ?? '-'}→${outcome.usage?.completion_tokens ?? '-'})`)
  }
  totalSkipped += projected.length - todo.length

  // 向量：为该会话新入库的摘要批量补嵌
  if (!DRY && vectorOk && newSummaries.length) {
    try {
      const vectors = await embedTexts(newSummaries.map((s) => s.text))
      newSummaries.forEach((s, i) => saveTurnVector(db, s.id, s.text, vectors[i]))
      console.log(`  → 已补 ${newSummaries.length} 条原文向量`)
    } catch (error) {
      console.log(`  [警告] 向量补嵌失败（不影响已入库内容）：${error.message}`)
    }
  }
  if (sessionNew) console.log(`  本会话新增 ${sessionNew} 轮`)
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const stats = db.prepare('SELECT COUNT(*) AS turns, COUNT(DISTINCT session_id) AS sessions FROM tm_turns').get()
const triples = db.prepare('SELECT COUNT(*) AS n FROM tm_triples').get().n
console.log('\n' + '─'.repeat(96))
console.log(`新增 ${totalNew} 轮 · 跳过（已存在）${totalSkipped} · 失败 ${totalFailed} · 耗时 ${elapsed}s`)
console.log(`token：输入 ${inTokens.toLocaleString('en-US')} · 输出 ${outTokens.toLocaleString('en-US')}`)
console.log(`库现状：${stats.turns} 轮 / ${stats.sessions} 会话 / ${triples} 条 SPO`)
db.close()
