/**
 * 自测：轮次记忆库地基（lib/turns/schema.js + lib/turns/store.js）
 * 跑法：node scripts/self-test-turns.mjs
 * 只在 _tmp/turns-selftest/run-<时间戳>/ 下建临时库，不碰真实工作区数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTurnsDb, turnsDbPathOf, turnsDbExists, migrate, SCHEMA_VERSION, OUTCOMES } from '../lib/turns/schema.js'
import {
  upsertTurn, getTurn, getTurnsByIds, getRecentTurnsBySession, getRecentTurnsBefore, getRecentTurns,
  replaceTriples, getTriplesForTurn, getTriplesForTurns, turnIdsForTerms, findTermIdsByText,
  saveTurnVector, getTurnVectorHash, getTurnVector, allTurnVectors, blobToVector,
  turnIdOf, termIdOf, normalizeTerm, statsOf, hasTurns,
} from '../lib/turns/store.js'

let pass = 0
let fail = 0
const failures = []
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name) }
  catch (error) { fail += 1; failures.push(name + ' → ' + error.message); console.log('  ✗', name, '→', error.message) }
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label} 期望 ${b}，实际 ${a}`)
}
function ok(value, label = '') { if (!value) throw new Error(`${label} 期望真值，实际 ${JSON.stringify(value)}`) }
function throws(fn, label = '') {
  let threw = false
  try { fn() } catch { threw = true }
  if (!threw) throw new Error(`${label} 应该抛错但没有`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.join(here, '..', '_tmp', 'turns-selftest', 'run-' + Date.now())
fs.mkdirSync(workspace, { recursive: true })
console.log('临时工作区:', workspace)

const DB = turnsDbPathOf(workspace)
let db = openTurnsDb(workspace)

console.log('\n【schema / migration】')
t('库文件落在 <workspace>/.dsh-semantic/turns.db', () => {
  ok(DB.endsWith(path.join('.dsh-semantic', 'turns.db')), '路径')
  ok(fs.existsSync(DB), '文件存在')
})
t('WAL 模式生效', () => eq(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'))
t('foreign_keys 生效', () => eq(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1))
t('SCHEMA_VERSION 至少含队列与会话水位（v4+）', () => ok(SCHEMA_VERSION >= 4, ))
t('_tm_migrations 记录连续版本（不硬编码数字）', () => eq(db.prepare('SELECT v FROM _tm_migrations ORDER BY v').all().map((r) => r.v), Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1)))
t('migrate 幂等：再跑不重跑', () => {
  const r = migrate(db)
  eq(r.from, SCHEMA_VERSION, 'from')
  eq(r.to, SCHEMA_VERSION, 'to')
  eq(db.prepare('SELECT COUNT(*) AS n FROM _tm_migrations').get().n, SCHEMA_VERSION)
})
t('六张表齐全（含抽取队列与会话水位）', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  for (const want of ['tm_turns', 'tm_vectors', 'tm_terms', 'tm_triples', 'tm_extraction_queue', 'tm_extraction_sessions']) ok(names.includes(want), want)
})
t('空库 hasTurns=false / stats 全零', () => {
  eq(hasTurns(db), false)
  const s = statsOf(db)
  eq([s.turns, s.sessions, s.terms, s.triples, s.vectors], [0, 0, 0, 0, 0])
})

console.log('\n【稳定身份与幂等写入】')
const S = 'session-aaaa'
const base = { sessionId: S, turnIndex: 0, summary: '备份并开始记忆沙龙', outcome: 'completed', userSeq: 10, answerSeq: 12, userText: '把目前状态备份', answerText: '备份完成，3.85GB' }
let turn1
t('upsertTurn 写入并回读一致', () => {
  turn1 = upsertTurn(db, base)
  eq(turn1.summary, base.summary)
  eq(turn1.outcome, 'completed')
  eq([turn1.userSeq, turn1.answerSeq], [10, 12])
  eq([turn1.userText, turn1.answerText], [base.userText, base.answerText])
  ok(turn1.id.startsWith('tm-'), 'id 前缀')
})
t('重放同一轮 → 同一个 id，行数不变', () => {
  const again = upsertTurn(db, base)
  eq(again.id, turn1.id)
  eq(statsOf(db).turns, 1)
})
t('seqs 顺序无关（排序后 hash）', () => eq(turnIdOf(S, [12, 10]), turnIdOf(S, [10, 12])))
t('不同 seqs → 不同 id', () => ok(turnIdOf(S, [10, 12]) !== turnIdOf(S, [10, 13]), 'id 应不同'))
t('不同 session → 不同 id', () => ok(turnIdOf(S, [10, 12]) !== turnIdOf('session-bbbb', [10, 12]), 'id 应不同'))
t('改摘要 → 同 id、内容更新、不新增行', () => {
  const updated = upsertTurn(db, { ...base, summary: '备份并开始记忆沙龙（改）' })
  eq(updated.id, turn1.id)
  eq(updated.summary, '备份并开始记忆沙龙（改）')
  eq(statsOf(db).turns, 1)
})
t('不传 turnIndex → SQL 原子分配（并发路径不会撞号，2026-10-08 实测踩过）', () => {
  const ws2 = path.join(workspace, '..', 'self-test-turns-atomic')
  fs.rmSync(ws2, { recursive: true, force: true })
  fs.mkdirSync(ws2, { recursive: true })
  const db2 = openTurnsDb(ws2)
  const mk = (us) => ({ sessionId: 'session-ai', summary: '摘要', outcome: 'completed', userSeq: us, answerSeq: us + 1, userText: '问', answerText: '答' })
  // 模拟"在线抽取"与"启动恢复"两条路径同时写入：都不传编号，各写各的
  const a = upsertTurn(db2, mk(1))
  const b = upsertTurn(db2, mk(3))
  const c = upsertTurn(db2, mk(5))
  eq([a.turnIndex, b.turnIndex, c.turnIndex], [0, 1, 2], '三条必须分到不同编号')
  // 幂等重写同一轮：编号保持不变（否则每写一次就跳号）
  const again = upsertTurn(db2, { ...mk(1), summary: '改过的摘要' })
  eq(again.turnIndex, 0, '重写不该改编号')
  eq(again.summary, '改过的摘要', '内容该更新')
  // 会话隔离：另一个会话从 0 重新开始
  const other = upsertTurn(db2, { ...mk(7), sessionId: 'session-other' })
  eq(other.turnIndex, 0, '按会话隔离')
  db2.close()
})

t('空 summary 抛错', () => throws(() => upsertTurn(db, { ...base, summary: '   ' }), 'summary'))
t('非法 outcome 抛错（应用层）', () => throws(() => upsertTurn(db, { ...base, outcome: 'done' }), 'outcome'))
t('非法 outcome 直插被 CHECK 拒绝（DB 层）', () => throws(() => {
  db.prepare("INSERT INTO tm_turns (id,session_id,turn_index,summary,outcome,user_seq,answer_seq,user_text,answer_text,answer_hash,created_at,updated_at) VALUES ('x','s',0,'s','bogus',1,2,'a','b','h',1,1)").run()
}, 'CHECK'))
t('userSeq === answerSeq 抛错', () => throws(() => upsertTurn(db, { ...base, userSeq: 9, answerSeq: 9 }), 'same seq'))
t('负数 / 非整数 seq 抛错', () => {
  throws(() => upsertTurn(db, { ...base, userSeq: -1 }), '负数')
  throws(() => upsertTurn(db, { ...base, userSeq: 1.5 }), '小数')
})
t('空 userText 抛错', () => throws(() => upsertTurn(db, { ...base, userText: '' }), 'userText'))

console.log('\n【SPO 导航】')
t('replaceTriples 写入两条（按入场顺序返回，source_order 稳定）', () => {
  const rows = replaceTriples(db, turn1.id, S, [
    { subject: 'dsh-memory-semantic', predicate: '新增', object: '轮次记忆库 turns.db' },
    { subject: '上下文接管', predicate: '前置步骤', object: '只读预演' },
  ])
  eq(rows.length, 2)
  eq(rows.map((r) => r.predicate), ['新增', '前置步骤'], '入场顺序')
  eq([...rows.map((r) => r.predicate)].sort(), ['前置步骤', '新增'], '集合')
})
t('再次 replace → 旧的删掉、不累积', () => {
  const rows = replaceTriples(db, turn1.id, S, [{ subject: '上下文接管', predicate: '前置步骤', object: '只读预演' }])
  eq(rows.length, 1)
  eq(getTriplesForTurn(db, turn1.id).length, 1)
})
t('词项跨轮复用（同 normalized → 同 term 行）', () => {
  const turn2 = upsertTurn(db, { ...base, turnIndex: 1, summary: '第二问', userSeq: 20, answerSeq: 22, userText: '第二个问题', answerText: '第二个回答' })
  replaceTriples(db, turn2.id, S, [{ subject: '上下文接管', predicate: '阶段', object: '阶段一' }])
  const terms = db.prepare('SELECT COUNT(*) AS n FROM tm_terms WHERE normalized=?').get('上下文接管')
  eq(terms.n, 1)
})
t('词项归一化：大小写 / 空白折叠', () => {
  eq(normalizeTerm('  Dsh   Project '), 'dsh project')
  eq(termIdOf(normalizeTerm('Dsh Project')), termIdOf(normalizeTerm('dsh   project')))
})
t('空 predicate → 抛错', () => throws(() => replaceTriples(db, turn1.id, S, [{ subject: 'a', predicate: '  ', object: 'b' }]), 'predicate'))
t('原子性：替换失败后旧三元组完好', () => {
  const before = getTriplesForTurn(db, turn1.id)
  throws(() => replaceTriples(db, turn1.id, S, [
    { subject: 'a', predicate: 'ok', object: 'b' },
    { subject: 'c', predicate: '', object: 'd' },
  ]), '第二条非法')
  eq(getTriplesForTurn(db, turn1.id).map((r) => r.predicate), before.map((r) => r.predicate), '旧数据')
})
t('重复三元组被 UNIQUE 忽略', () => {
  const rows = replaceTriples(db, turn1.id, S, [
    { subject: '上下文接管', predicate: '前置步骤', object: '只读预演' },
    { subject: '上下文接管', predicate: '前置步骤', object: '只读预演' },
  ])
  eq(rows.length, 1)
})
t('turnIdsForTerms 命中轮次', () => {
  const termIds = db.prepare('SELECT id FROM tm_terms WHERE normalized=?').all('上下文接管').map((r) => String(r.id))
  const ids = turnIdsForTerms(db, termIds)
  ok(ids.length >= 2, '至少两轮命中')
})
t('findTermIdsByText 严格词法回退可命中', () => {
  const ids = findTermIdsByText(db, '上下文接管 前置步骤')
  ok(ids.length >= 1, '命中词项')
})
t('getTriplesForTurns 批量取', () => {
  const all = getTriplesForTurns(db, [turn1.id])
  eq(all.length, 1)
})

console.log('\n【向量】')
t('写向量 + 读回 hash', () => {
  saveTurnVector(db, turn1.id, 'summary text', [0.1, 0.2, 0.3, -0.4])
  eq(getTurnVectorHash(db, turn1.id), getTurnVectorHash(db, turn1.id))
  ok(getTurnVectorHash(db, turn1.id)?.length === 64, 'sha256 hex')
})
t('blob 往返（Float32 精度）', () => {
  const v = getTurnVector(db, turn1.id)
  eq(v.length, 4)
  ok(Math.abs(v[3] + 0.4) < 1e-6, 'f32 往返')
})
t('内容变 → hash 变、向量覆盖', () => {
  const h1 = getTurnVectorHash(db, turn1.id)
  saveTurnVector(db, turn1.id, 'summary text v2', [1, 0, 0, 0])
  const h2 = getTurnVectorHash(db, turn1.id)
  ok(h1 !== h2, 'hash 应变化')
  eq(statsOf(db).vectors, 1)
})
t('allTurnVectors 可枚举', () => {
  const all = allTurnVectors(db)
  eq(all.length, 1)
  eq(all[0].turnId, turn1.id)
})
t('blobToVector 直接解 Buffer', () => {
  const f32 = Float32Array.from([1.5, -2.5])
  const v = blobToVector(Buffer.from(f32.buffer))
  eq([v[0], v[1]], [1.5, -2.5])
})

console.log('\n【查询原语与级联】')
t('getRecentTurnsBySession 旧→新', () => {
  const rows = getRecentTurnsBySession(db, S, 5)
  eq(rows.map((r) => r.turnIndex), [0, 1])
})
t('getRecentTurnsBefore 防自喂', () => {
  eq(getRecentTurnsBefore(db, S, 1, 5).map((r) => r.turnIndex), [0])
})
t('getRecentTurns 跨会话时间序', () => ok(getRecentTurns(db, 10).length === 2, '两条'))
t('getTurnsByIds', () => eq(getTurnsByIds(db, [turn1.id]).length, 1))
t('级联删除：删轮次 → triples/vectors 跟着删', () => {
  const turn2 = getRecentTurnsBySession(db, S, 5)[1]
  db.prepare('DELETE FROM tm_turns WHERE id=?').run(turn2.id)
  eq(getTriplesForTurn(db, turn2.id).length, 0)
  eq(db.prepare('SELECT COUNT(*) AS n FROM tm_vectors WHERE turn_id=?').get(turn2.id).n, 0)
})
t('statsOf 汇总正确', () => {
  const s = statsOf(db)
  eq([s.turns, s.vectors, s.triples], [1, 1, 1])
  ok(Array.isArray(s.outcomes) && s.outcomes.length === 1, 'outcomes 分组')
})

console.log('\n【持久化与边界】')
t('关闭重开：数据仍在', () => {
  db.close()
  db = openTurnsDb(workspace)
  eq(statsOf(db).turns, 1)
  eq(getTurn(db, turn1.id).summary, '备份并开始记忆沙龙（改）')
})
t('只读打开可读', () => {
  const ro = openTurnsDb(workspace, { readOnly: true })
  eq(statsOf(ro).turns, 1)
  ro.close()
})
t('turnsDbExists 对未建过库的工作区为 false', () => {
  eq(turnsDbExists(path.join(here, '..', '_tmp', 'turns-selftest', 'never-created-' + Date.now())), false)
})
t('只写 .dsh-semantic，不动 .dsh-meow（不碰基座红线）', () => {
  const entries = fs.readdirSync(workspace)
  eq(entries, ['.dsh-semantic'])
  ok(!fs.existsSync(path.join(workspace, '.dsh-meow')), '.dsh-meow 不应存在')
})
t('openTurnsDb 拒绝空 workspace', () => throws(() => openTurnsDb(''), 'workspace'))

db.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('临时库保留在:', DB)
