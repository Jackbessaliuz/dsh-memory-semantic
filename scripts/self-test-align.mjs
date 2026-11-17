// self-test-align —— 轮次对齐（source-backed 强定位）自测
// 合成用例验口径，真实会话验命中；真实数据不可达时自动跳过而不算失败。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseEditHistory, buildGroups, findSessionLogByPrefix, buildAlignmentFromLog,
  alignForSessions, locateEvent, locateAll, groupAt, CACHE_VERSION,
} from '../lib/turns/align.js'

const WORKSPACE = process.env.DSH_WORKSPACE || path.resolve(import.meta.dirname, '../../..')
// 真实会话用例可选：设 DSH_TEST_SESSION_SHORT=<短id> 才会跑
const REAL_SHORT = String(process.env.DSH_TEST_SESSION_SHORT || '').trim()
let pass = 0
const fails = []
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name) } catch (e) { fails.push({ name, err: e }); console.log('  ✗', name, '--', e.message) }
}

console.log('\n[1] parseEditHistory —— 格式与语义')
ok('单轮事件', () => {
  const [ev] = parseEditHistory('jot-update-28a7537f-turn(31)')
  assert.equal(ev.scenario, 'jot')
  assert.equal(ev.action, 'update')
  assert.equal(ev.shortSession, '28a7537f')
  assert.equal(ev.turn, 31)
  assert.equal(ev.turnRange, null)
})
ok('区间事件：turn 取 b、turnRange 存 [a,b]', () => {
  const [ev] = parseEditHistory('dream-update-28a7537f-turnRange(30,32)')
  assert.equal(ev.scenario, 'dream')
  assert.equal(ev.turn, 32)
  assert.deepEqual(ev.turnRange, [30, 32])
})
ok('多条事件按 "; " 切开', () => {
  const evs = parseEditHistory('jot-update-28a7537f-turn(31); dream-update-28a7537f-turnRange(30,32)')
  assert.equal(evs.length, 2)
  assert.equal(evs[1].scenario, 'dream')
})
ok('空串 → 空数组', () => assert.deepEqual(parseEditHistory(''), []))
ok('脏数据标 unparsed 而不是抛', () => {
  const [ev] = parseEditHistory('什么鬼格式')
  assert.equal(ev.unparsed, true)
})

console.log('\n[2] buildGroups —— 绝对轮分组（含插件续轮）')
const synth = [
  { type: 'turn/start' },
  { type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'meow-memory' }, content: [{ type: 'text', text: '注入' }] } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真问题' }] } },
  { type: 'assistant/message', seq: 3 },
  { type: 'turn/start' },
  { type: 'user/message', seq: 4, data: { source: { kind: 'plugin', plugin: 'dsh-perception' }, content: [{ type: 'text', text: 'notice' }] } },
  { type: 'turn/start' },
  { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '===== 长期记忆 =====\n注入块' }, { type: 'text', text: '第二个问题' }] } },
]
ok('3 个绝对轮 → 2 个真用户轮，插件续轮 userSeq 为 null', () => {
  const g = buildGroups(synth)
  assert.equal(g.length, 3)
  assert.equal(g[0].userSeq, 2)
  assert.equal(g[1].userSeq, null)
  assert.equal(g[2].userSeq, 5)
})
ok('组内首个真用户轮才作数（插件注入不算）', () => {
  const g = buildGroups(synth)
  assert.equal(g[0].quote, '真问题')
})
ok('头部注入块被剥掉，只留真问题', () => {
  const g = buildGroups(synth)
  assert.equal(g[2].quote, '第二个问题')
})
ok('turn/start 之前的孤儿事件不崩', () => {
  const g = buildGroups([{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '孤儿' }] } }, { type: 'turn/start' }])
  assert.equal(g.length, 1)
  assert.equal(g[0].userSeq, null)
})
ok('groupAt 越界/非法返回 null', () => {
  const g = buildGroups(synth)
  assert.equal(groupAt({ groups: g }, 99), null)
  assert.equal(groupAt({ groups: g }, 2), null)   // 插件续轮
  assert.equal(groupAt({ groups: g }, 'x'), null)
})

console.log('\n[3] locateEvent —— 区间事件指向素材轮而不是处理轮')
const fakeAlign = { groups: buildGroups(synth) }
ok('单轮 → 该轮组内真用户轮', () => {
  const loc = locateEvent(fakeAlign, { scenario: 'jot', action: 'update', shortSession: 'abcdef12', turn: 3, turnRange: null })
  assert.equal(loc.absTurn, 3)
  assert.equal(loc.userSeq, 5)
})
ok('turnRange(1,3) → 素材轮 1..2，取第一轮真用户轮', () => {
  const loc = locateEvent(fakeAlign, { scenario: 'dream', action: 'update', shortSession: 'abcdef12', turn: 3, turnRange: [1, 3] })
  assert.equal(loc.absTurn, 1)
  assert.equal(loc.range, true)
})
ok('locateAll 给出素材区间里所有真用户轮（不是只给首轮）', () => {
  const synth2 = buildGroups([
    { type: 'turn/start' },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮' }] } },
    { type: 'turn/start' },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] } },
    { type: 'turn/start' },
  ])
  const all = locateAll({ groups: synth2 }, { scenario: 'dream', action: 'update', shortSession: 'abcdef12', turn: 3, turnRange: [1, 3] })
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((x) => x.absTurn), [1, 2])
  assert.equal(locateEvent({ groups: synth2 }, { scenario: 'dream', action: 'update', shortSession: 'abcdef12', turn: 3, turnRange: [1, 3] }).absTurn, 1)
})
ok('locateAll 有上限（默认最多 6 个）', () => {
  const evs = [{ type: 'turn/start' }]
  for (let i = 0; i < 20; i += 1) {
    evs.push({ type: 'user/message', seq: i, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' + i }] } })
    evs.push({ type: 'turn/start' })
  }
  const all = locateAll({ groups: buildGroups(evs) }, { scenario: 'dream', action: 'update', shortSession: 'abcdef12', turn: 21, turnRange: [1, 22] })
  assert.equal(all.length, 6)
})
ok('区间内全是插件轮 → 继续往后找，找不到返回 null', () => {
  const only = { groups: buildGroups([{ type: 'turn/start' }, { type: 'user/message', seq: 1, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'x' }] } }]) }
  assert.equal(locateEvent(only, { scenario: 'dream', action: 'update', shortSession: 'abcdef12', turn: 1, turnRange: [1, 2] }), null)
})
ok('unparsed 事件返回 null', () => {
  assert.equal(locateEvent(fakeAlign, { unparsed: true, raw: 'x' }), null)
})

console.log('\n[4] 真实会话')
const logFile = findSessionLogByPrefix(REAL_SHORT)
if (!logFile) {
  console.log(`  ⏭ 未设置 DSH_TEST_SESSION_SHORT 或找不到该会话日志（跳过真实数据用例）`)
} else {
  console.log('  日志：', logFile)
  const al = buildAlignmentFromLog(logFile)
  ok('32 个绝对轮 / 17 个真用户轮', () => {
    assert.equal(al.groups.length, 32)
    assert.equal(al.realTurns, 17)
  })
  ok('jot-update-turn(31) → 第 31 绝对轮 → 用户原话是"这个会话先结束吧…"', () => {
    const loc = locateEvent(al, { scenario: 'jot', action: 'update', shortSession: REAL_SHORT, turn: 31, turnRange: null })
    assert.equal(loc.absTurn, 31)
    assert.match(loc.quote, /这个会话先结束吧/)
  })
  ok('dream-update-turnRange(30,32) → 素材首轮 → "现在应该算圆满收工了吧"', () => {
    const loc = locateEvent(al, { scenario: 'dream', action: 'update', shortSession: REAL_SHORT, turn: 32, turnRange: [30, 32] })
    assert.equal(loc.absTurn, 30)
    assert.match(loc.quote, /圆满收工/)
  })
  ok('对齐缓存：第二次同会话命中缓存', () => {
    const a = alignForSessions([REAL_SHORT], { workspace: WORKSPACE })
    const b = alignForSessions([REAL_SHORT], { workspace: WORKSPACE })
    assert.ok(a.get(REAL_SHORT))
    assert.equal(b.get(REAL_SHORT).cached, true)
    const cache = JSON.parse(fs.readFileSync(`${WORKSPACE}/.dsh-semantic/align-cache.json`, 'utf8'))
    assert.equal(cache.version, CACHE_VERSION)
    assert.ok(Array.isArray(cache.sessions[REAL_SHORT].groups))
  })
  ok('未知短 id → null（不抛）', () => {
    assert.equal(alignForSessions(['ffffffff'], { workspace: WORKSPACE }).get('ffffffff'), null)
  })
}

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  for (const f of fails) console.log('FAILED:', f.name, '\n', f.err)
  process.exit(1)
}
