/**
 * eval-recall —— 用真实会话量召回命中率（零 API 成本）
 *
 * 做两件事：
 *  1. **机制上限检查**：用投影出的真实 Q/A 当索引文本，跑 BM25 / 向量 / 融合三路，看命中率——
 *     原文信息最全，找不回来就是机制问题，与模型无关。
 *  2. **摘要化损耗预估**：把索引文本截断成 60 字（模拟 LLM 摘要的长度与信息损失）再跑一遍，
 *     两次差值就是"摘要化损耗"。损耗小 → 抽取可以用便宜档位；损耗大 → 需要更好的档位或双索引。
 *
 * 跑法：node scripts/eval-recall.mjs [sessionId ...]
 * 默认取最近 3 个有内容的会话。图路线不参与评估（它的输入是 LLM 抽出的 SPO，此时还没有）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTurnsDb } from '../lib/turns/schema.js'
import { upsertTurn } from '../lib/turns/store.js'
import { saveTurnVector } from '../lib/turns/store.js'
import { readSessionEvents, findSessionLog } from '../lib/turns/session-log.js'
import { projectCompletedTurns } from '../lib/turns/project.js'
import { lexicalRoute, vectorRoute } from '../lib/turns/recall.js'
import { fuseRoutes } from '../lib/turns/text.js'
import { embedTexts, embedQuery, ollamaHealthy, embedModel } from '../lib/turns/embed.js'

// 评估目标会话一律由参数或 EVAL_SESSIONS 传入（不在仓库里内置任何具体会话 id）
const sessions = process.argv.slice(2).filter((a) => a.startsWith('session-'))
const envSessions = (process.env.EVAL_SESSIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const targets = sessions.length ? sessions : envSessions
if (!targets.length) {
  console.error('用法: node scripts/eval-recall.mjs <session-id> [...]   或设 EVAL_SESSIONS=a,b,c')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const stamp = Date.now()

/* ── 查询构造（确定性，可复现） ───────────────────────────────────── */
function makeQueries(userText) {
  const text = String(userText).replace(/\s+/g, ' ').trim()
  const out = [{ kind: 'full', query: text }]
  if (text.length > 14) out.push({ kind: 'head12', query: text.slice(0, 12) })
  if (text.length > 26) {
    // 取中段 12 字：模拟"记得大概聊过、措辞记不全"
    const start = Math.floor((text.length - 12) / 2)
    out.push({ kind: 'frag12', query: text.slice(start, start + 12) })
  }
  return out
}

function rankOf(list, targetId) {
  const index = list.findIndex((x) => x.id === targetId)
  return index === -1 ? Infinity : index + 1
}

function accumulate(store, kind, route, rank) {
  const key = `${kind}|${route}`
  if (!store.has(key)) store.set(key, { n: 0, r1: 0, r3: 0, r5: 0, rr: 0, miss: 0 })
  const acc = store.get(key)
  acc.n += 1
  if (rank <= 1) acc.r1 += 1
  if (rank <= 3) acc.r3 += 1
  if (rank <= 5) acc.r5 += 1
  if (!Number.isFinite(rank)) acc.miss += 1
  else acc.rr += 1 / rank
  return acc
}

function pct(a, b) {
  return b === 0 ? '  -  ' : ((a / b) * 100).toFixed(1).padStart(5) + '%'
}

function printTable(title, stats, kinds = ['full', 'head12', 'frag12']) {
  console.log(`\n${title}`)
  console.log('  查询类型   路线     Recall@1  Recall@3  Recall@5    MRR    未命中')
  const routes = ['bm25', 'vector', 'fusion', 'weighted', 'gated']
  for (const kind of kinds) {
    for (const route of routes) {
      const acc = stats.get(`${kind}|${route}`)
      if (!acc) continue
      console.log(
        `  ${kind.padEnd(10)} ${route.padEnd(8)} ${pct(acc.r1, acc.n)}   ${pct(acc.r3, acc.n)}   ${pct(acc.r5, acc.n)}   ${(acc.rr / acc.n).toFixed(3)}   ${String(acc.miss).padStart(4)}/${acc.n}`,
      )
    }
  }
}

/* ── 主流程 ───────────────────────────────────────────────────────── */
const healthy = await ollamaHealthy()
console.log(`向量引擎：${healthy ? `可用（${embedModel()}）` : '不可用（只跑词法）'}`)

// 1. 投影各会话的完成轮
const turns = []
for (const sid of targets) {
  const file = findSessionLog(sid)
  if (!file) { console.log(`  [跳过] 找不到日志：${sid}`); continue }
  const log = readSessionEvents(file)
  const projected = projectCompletedTurns(log.events, { sessionId: log.header.id })
  console.log(`  ${sid.slice(0, 20)}  事件 ${log.events.length}  完成轮 ${projected.length}`)
  for (const turn of projected) turns.push(turn)
}
if (turns.length === 0) { console.error('没有可评估的轮次'); process.exit(1) }
console.log(`合计 ${turns.length} 轮`)

/* 索引模式：原文（机制上限） / 截断 60 字（模拟摘要） / 真摘要（跑过 sample-extract 才有） */
const MODES = [
  { name: 'full', summaryOf: (t) => t.userText.replace(/\s+/g, ' ').trim() },
  { name: 'head60', summaryOf: (t) => t.userText.replace(/\s+/g, ' ').trim().slice(0, 60) },
]

// 真摘要：来自 scripts/sample-extract.mjs 的产物，用它当索引才能量出真实的"摘要化损耗"
const realSummaries = new Map()
{
  const explicit = process.argv.find((a) => a.startsWith('--realsummary='))?.split('=')[1]
  const dir = path.join(here, '..', '_tmp', 'sample-extract')
  let file = explicit
  if (!file && fs.existsSync(dir)) {
    const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    if (runs.length) file = path.join(dir, runs[runs.length - 1])
  }
  if (file && fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const turn of data.turns ?? []) {
      if (turn.ok && turn.summary) realSummaries.set(`${data.sessionId}:${turn.turnIndex}`, turn.summary)
    }
    console.log(`真摘要：${path.basename(file)} → ${realSummaries.size} 轮可用（会话 ${String(data.sessionId).slice(0, 20)}）`)
  }
}
const MODES_USED = realSummaries.size
  ? [...MODES, {
      name: 'real',
      summaryOf: (t) => realSummaries.get(`${t.sessionId}:${t.turnIndex}`),
      filter: (t) => realSummaries.has(`${t.sessionId}:${t.turnIndex}`),
    }]
  : MODES

/**
 * 同口径开关：真摘要只覆盖部分轮次，若各模式跑不同轮次集，算出来的"损耗"是假的。
 * 加 --sameSubset 让所有模式都只用真摘要覆盖的那批轮次，才隔离出"索引文本"这一个变量。
 */
const sameSubset = process.argv.includes('--sameSubset') && realSummaries.size > 0
const subsetFilter = sameSubset ? (t) => realSummaries.has(`${t.sessionId}:${t.turnIndex}`) : null
if (sameSubset) console.log('同口径模式：所有索引模式只评估真摘要覆盖的轮次')

const summaryReport = []
for (const mode of MODES_USED) {
  const useTurns = turns.filter(mode.filter ?? subsetFilter ?? (() => true))
  const workspace = path.join(here, '..', '_tmp', 'recall-eval', `run-${stamp}-${mode.name}`)
  fs.mkdirSync(workspace, { recursive: true })
  const db = openTurnsDb(workspace)

  // 2. 灌库
  for (const turn of useTurns) {
    upsertTurn(db, {
      sessionId: turn.sessionId,
      turnIndex: turn.turnIndex,
      summary: mode.summaryOf(turn),
      outcome: 'completed',
      userSeq: turn.userSeq,
      answerSeq: turn.answerSeq,
      userText: turn.userText,
      answerText: turn.answerText,
    })
  }

  // 3. 向量索引（每个模式各自算）
  let vectorOk = false
  if (healthy) {
    const ids = db.prepare('SELECT id, summary FROM tm_turns ORDER BY rowid').all()
    try {
      const vectors = await embedTexts(ids.map((r) => String(r.summary)))
      ids.forEach((r, i) => saveTurnVector(db, String(r.id), String(r.summary), vectors[i]))
      vectorOk = true
    } catch (error) {
      console.log(`  [警告] 向量索引失败，只跑词法：${error.message}`)
    }
  }

  // 4. 评估
  const stats = new Map()
  const allIds = db.prepare('SELECT id, session_id, user_seq FROM tm_turns').all()
    .map((r) => ({ id: String(r.id), sessionId: String(r.session_id), userSeq: Number(r.user_seq) }))
  const byKey = new Map(allIds.map((r) => [`${r.sessionId}:${r.userSeq}`, r.id]))

  let queryCount = 0
  for (const turn of useTurns) {
    const targetId = byKey.get(`${turn.sessionId}:${turn.userSeq}`)
    if (!targetId) continue
    for (const { kind, query } of makeQueries(turn.userText)) {
      queryCount += 1
      const lexical = lexicalRoute(db, query, allIds)
      accumulate(stats, kind, 'bm25', rankOf(lexical, targetId))
      let vector = []
      if (vectorOk) {
        const queryVector = await embedQuery(query)
        if (queryVector) {
          vector = vectorRoute(db, queryVector, allIds)
          accumulate(stats, kind, 'vector', rankOf(vector, targetId))
        }
      }
      const routeLists = []
      if (lexical.length) routeLists.push({ name: 'bm25', list: lexical })
      if (vector.length) routeLists.push({ name: 'vector', list: vector })
      const fusedEqual = fuseRoutes(routeLists, { k: 5, pool: 10, mode: 'weighted', weights: { bm25: 1, vector: 1 } })
      const fusedWeighted = fuseRoutes(routeLists, { k: 5, pool: 10, mode: 'weighted' })
      const fusedGated = fuseRoutes(routeLists, { k: 5, pool: 10, mode: 'gated' })
      accumulate(stats, kind, 'fusion', rankOf(fusedEqual, targetId))
      accumulate(stats, kind, 'weighted', rankOf(fusedWeighted, targetId))
      accumulate(stats, kind, 'gated', rankOf(fusedGated, targetId))
    }
  }

  printTable(`【索引模式 ${mode.name}${mode.name === 'head60' ? '（= 摘要化 60 字）' : mode.name === 'full' ? '（原文，机制上限）' : '（真摘要）'}】查询 ${queryCount} 条 · 轮次 ${useTurns.length}`, stats)
  summaryReport.push({ mode: mode.name, stats, queries: queryCount })

  // ── 人工改写查询：换词/同义、刻意避开原文独特词——公平评估语义路线的唯一方式 ──
  const fixturePath = path.join(here, 'fixtures', 'rewritten-queries.json')
  if (fs.existsSync(fixturePath)) {
    const items = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).items ?? []
    const byTurn = new Map(useTurns.map((t) => [`${t.sessionId}:${t.turnIndex}`, t]))
    const rewriteStats = new Map()
    let used = 0
    for (const item of items) {
      const turn = byTurn.get(`${item.sessionId}:${item.turnIndex}`)
      if (!turn) continue
      const targetId = byKey.get(`${turn.sessionId}:${turn.userSeq}`)
      if (!targetId) continue
      used += 1
      const query = String(item.query)
      const lexical = lexicalRoute(db, query, allIds)
      let vector = []
      if (vectorOk) {
        const queryVector = await embedQuery(query)
        if (queryVector) vector = vectorRoute(db, queryVector, allIds)
      }
      const routeLists = []
      if (lexical.length) routeLists.push({ name: 'bm25', list: lexical })
      if (vector.length) routeLists.push({ name: 'vector', list: vector })
      accumulate(rewriteStats, 'rewrite', 'bm25', rankOf(lexical, targetId))
      if (vectorOk) accumulate(rewriteStats, 'rewrite', 'vector', rankOf(vector, targetId))
      accumulate(rewriteStats, 'rewrite', 'fusion', rankOf(fuseRoutes(routeLists, { k: 5, pool: 10, mode: 'weighted', weights: { bm25: 1, vector: 1 } }), targetId))
      accumulate(rewriteStats, 'rewrite', 'weighted', rankOf(fuseRoutes(routeLists, { k: 5, pool: 10, mode: 'weighted' }), targetId))
      accumulate(rewriteStats, 'rewrite', 'gated', rankOf(fuseRoutes(routeLists, { k: 5, pool: 10, mode: 'gated' }), targetId))
    }
    if (used) printTable(`【人工改写查询 · 索引=${mode.name}】${used} 条（换词/同义，避开原文独特词）`, rewriteStats, ['rewrite'])
  }
  db.close()
}

/* ── 摘要化损耗（最后一个模式 vs 原文基准） ───────────────────────── */
if (summaryReport.length >= 2) {
  const base = summaryReport[0]
  const other = summaryReport[summaryReport.length - 1]
  console.log(`\n【摘要化损耗（${other.mode} vs ${base.mode}）】`)
  console.log('  查询类型   路线      R@1 变化    R@5 变化    MRR 变化')
  for (const kind of ['full', 'head12', 'frag12']) {
    for (const route of ['bm25', 'vector', 'fusion', 'weighted', 'gated']) {
      const a = base.stats.get(`${kind}|${route}`)
      const b = other.stats.get(`${kind}|${route}`)
      if (!a || !b) continue
      const delta = (x, y, n) => `${(((x - y) / Math.max(y, 1)) * 100).toFixed(1)}%`
      console.log(
        `  ${kind.padEnd(10)} ${route.padEnd(8)} ${delta(b.r1 / b.n, a.r1 / a.n).padStart(8)}   ${delta(b.r5 / b.n, a.r5 / a.n).padStart(8)}    ${delta(b.rr / b.n, a.rr / a.n).padStart(8)}`,
      )
    }
  }
}
console.log('\n（图路线未参与：它的输入是 LLM 抽出的 SPO，本轮评估尚无该数据）')
