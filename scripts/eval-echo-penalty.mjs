/**
 * eval-echo-penalty —— 量化"回声降权 + 查询门控"的收益（零 API 成本，只读真库）
 *
 * 口径：用 `fixtures/rewritten-queries.json` 的人工改写查询（每条绑定一个目标轮次），
 * 对比【关闭】与【开启】降权/门控时：
 *   · 目标轮的 Recall@1 / @3 / @5 / MRR（**召回**没变差吗）
 *   · Top-5 里"回声轮（二阶元讨论）"的占比（**精度**变好了吗）
 *
 * 跑法：node scripts/eval-echo-penalty.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTurnsDb } from '../lib/turns/schema.js'
import { recallTurns, informativeLength } from '../lib/turns/recall.js'
import { embedQuery, ollamaHealthy, embedModel } from '../lib/turns/embed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = process.env.EVAL_WORKSPACE || process.cwd()
const fixturePath = path.join(here, 'fixtures', 'rewritten-queries.json')
const items = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).items ?? []

const db = openTurnsDb(WORKSPACE, { readOnly: true })
const rows = db.prepare('SELECT id, session_id, turn_index FROM tm_turns').all()
const byKey = new Map(rows.map((r) => [`${r.session_id}:${r.turn_index}`, String(r.id)]))
const healthy = await ollamaHealthy()
console.log(`库 ${WORKSPACE}\\.dsh-semantic\\turns.db：${rows.length} 轮`)
console.log(`查询集 ${path.basename(fixturePath)}：${items.length} 条`)
console.log(`向量引擎：${healthy ? `可用（${embedModel()}）` : '不可用（只跑词法+图）'}`)

const PROFILES = [
  { name: 'baseline  三种门控全关', opts: { echoPenalty: false, minQueryChars: 0, minTurnChars: 0 } },
  { name: 'A 查询门控（4 字）', opts: { echoPenalty: false, minTurnChars: 0 } },
  { name: 'C 查询门控 + 内容门控（20 实义字）', opts: { echoPenalty: false } },
  { name: 'B 门控 + 回声降权（默认已关，对照）', opts: { echoPenalty: true } },
]

const pct = (a, b) => (b === 0 ? '  -  ' : ((a / b) * 100).toFixed(1).padStart(5) + '%')

for (const profile of PROFILES) {
  let n = 0, r1 = 0, r3 = 0, r5 = 0, rr = 0, miss = 0, gated = 0, echoHits = 0, echoQueries = 0
  const thinQueries = []
  for (const item of items) {
    const targetId = byKey.get(`${String(item.sessionId)}:${Number(item.turnIndex)}`)
    if (!targetId) continue
    const queryVector = healthy ? await embedQuery(String(item.query)) : null
    const { results, diagnostics } = recallTurns(db, {
      query: String(item.query), queryVector, k: 5, ...profile.opts,
    })
    if (diagnostics.gated) {
      gated += 1
      thinQueries.push(`${informativeLength(item.query)}字「${item.query}」`)
      continue
    }
    n += 1
    const rank = results.findIndex((r) => r.turnId === targetId) + 1
    if (rank === 1) r1 += 1
    if (rank >= 1 && rank <= 3) r3 += 1
    if (rank >= 1 && rank <= 5) r5 += 1
    if (rank > 0) rr += 1 / rank
    else miss += 1
    const echoes = results.filter((r) => r.echo).length
    echoHits += echoes
    if (echoes > 0) echoQueries += 1
  }
  console.log(`\n【${profile.name}】参与 ${n} 条${gated ? `（门控挡掉 ${gated} 条：${thinQueries.join('、')}）` : ''}`)
  console.log(`  Recall@1 ${pct(r1, n)}   Recall@3 ${pct(r3, n)}   Recall@5 ${pct(r5, n)}   MRR ${(rr / Math.max(n, 1)).toFixed(3)}   未命中 ${miss}/${n}`)
  console.log(`  Top-5 里回声轮：${echoHits} 条（${(echoHits / Math.max(n * 5, 1) * 100).toFixed(1)}% 的位次）｜至少含 1 条回声的查询：${echoQueries}/${n}`)
}

db.close()
