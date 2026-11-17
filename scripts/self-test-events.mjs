// self-test-events —— 原始事件回查层（recall_events 的底座）自测
// 合成用例验口径，真实会话验命中；真实数据不可达时跳过而不算失败。
import assert from 'node:assert/strict'
import {
  buildTurnWindows, sliceBySeq, summarizeEvent, readEvents, isRealUserPrompt,
} from '../lib/turns/events.js'
import { findSessionLogByPrefix } from '../lib/turns/align.js'

let pass = 0
const fails = []
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name) } catch (e) { fails.push({ name, err: e }); console.log('  ✗', name, '--', e.message) }
}

const U = (seq, text) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const PLUG = (seq) => ({ seq, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'meow-memory' }, content: [{ type: 'text', text: '注入' }] } })
const A = (seq, { reasoning = '', text = '', calls = [], usage = null } = {}) => ({
  seq, type: 'assistant/message',
  data: {
    turn: 1, step: 1,
    message: {
      role: 'assistant',
      content: [
        ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
        ...(text ? [{ type: 'text', text }] : []),
        ...calls.map((c) => ({ type: 'tool-call', id: c.id || 'c1', name: c.name, arguments: c.args })),
      ],
    },
    usage: usage || undefined,
    stream: [{ type: 'chunk', chunk: { type: 'block-start' } }],
  },
})
const TC = (seq, name, args) => ({ seq, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name, arguments: args } })
const TR = (seq, text, isError = false) => ({ seq, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', isError, content: [{ type: 'text', text }] } } })

console.log('\n[1] buildTurnWindows —— 只认真用户轮')
const stream1 = [
  PLUG(1), U(2, '第一问'), A(3, { reasoning: 'r1', text: '中间' }), TC(4, 'read', '{"path":"a"}'), TR(5, '文件内容'),
  A(6, { reasoning: 'r2', text: '最终答一' }),
  U(7, '第二问'), A(8, { text: '最终答二' }),
]
ok('插件注入的 user/message 不算一轮', () => {
  assert.equal(isRealUserPrompt(PLUG(1)), false)
  assert.equal(isRealUserPrompt(U(2, 'x')), true)
  assert.equal(buildTurnWindows(stream1).length, 2)
})
ok('窗口按 seq 闭区间切（到下一条真用户消息前）', () => {
  const w = buildTurnWindows(stream1)
  assert.equal(w[0].userSeq, 2)
  assert.equal(w[0].from, 2)
  assert.equal(w[0].to, 6)
  assert.equal(w[1].from, 7)
  assert.equal(w[1].to, 8)
})
ok('index 从 0 起、与 turn_index 同基准', () => {
  const w = buildTurnWindows(stream1)
  assert.deepEqual(w.map((x) => x.index), [0, 1])
})
ok('空流不崩', () => assert.deepEqual(buildTurnWindows([]), []))

console.log('\n[2] sliceBySeq —— 按 seq 比较，不依赖下标连续')
ok('区间内含缺号也能正确切', () => {
  const got = sliceBySeq([{ seq: 1 }, { seq: 5 }, { seq: 9 }], 2, 9)
  assert.deepEqual(got.map((e) => e.seq), [5, 9])
})
ok('不给边界＝全取', () => {
  assert.equal(sliceBySeq([{ seq: 1 }, { seq: 2 }]).length, 2)
})

console.log('\n[3] summarizeEvent —— 摘要永远不带 stream')
ok('user/message 给 kind 与文本', () => {
  const s = summarizeEvent(U(2, '你好'))
  assert.equal(s.seq, 2); assert.equal(s.kind, 'user'); assert.equal(s.text, '你好')
})
ok('assistant/message 拆出 reasoning 字数 / 可见文本 / toolCalls / usage', () => {
  const s = summarizeEvent(A(6, { reasoning: 'x'.repeat(120), text: '答', calls: [{ name: 'read', args: '{"p":1}' }], usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3000 } }))
  assert.equal(s.reasoningChars, 120)
  assert.equal(s.text, '答')
  assert.equal(s.toolCalls[0].name, 'read')
  assert.deepEqual(s.usage, { input: 100, output: 20, cacheRead: 3000 })
})
ok('**任何类型的摘要都不含 stream / replayState**', () => {
  const s = summarizeEvent(A(6, { text: '答', usage: { inputTokens: 1 } }))
  const dump = JSON.stringify(s)
  assert.equal(dump.includes('stream'), false, dump.slice(0, 200))
  assert.equal(dump.includes('replayState'), false)
})
ok('tool/call 给工具名与参数', () => {
  const s = summarizeEvent(TC(4, 'read', '{"path":"a"}'))
  assert.equal(s.name, 'read'); assert.equal(s.text, '{"path":"a"}')
})
ok('tool/result 给 callId / isError / 文本', () => {
  const s = summarizeEvent(TR(5, '内容', true))
  assert.equal(s.callId, 'c1'); assert.equal(s.isError, true); assert.equal(s.text, '内容')
})
ok('超长文本按 maxChars 截断并标注剩余', () => {
  const s = summarizeEvent(TR(5, 'x'.repeat(2000)), { maxChars: 100 })
  assert.match(s.text, /…\[\+1900字\]$/)
})
ok('compaction/prune 带出被遮蔽的 seq 与 token', () => {
  const s = summarizeEvent({ seq: 2285, type: 'compaction/prune', data: { shadowedRange: { start: 38, end: 38 }, shadowedSeqs: [38], shadowedTokenCount: 6194 } })
  assert.deepEqual(s.shadowedSeqs, [38])
  assert.equal(s.shadowedTokenCount, 6194)
})

console.log('\n[4] readEvents —— 按轮 / 按 seq / 按类型')
const fakeReader = null
ok('（合成路径）按轮窗口取事件', () => {
  // readEvents 读文件，这里只校验窗口计算的等价逻辑：第 0 轮 = seq 2..6
  const w = buildTurnWindows(stream1)[0]
  const got = sliceBySeq(stream1, w.from, w.to)
  assert.deepEqual(got.map((e) => e.seq), [2, 3, 4, 5, 6])
})

// 真实会话用例是可选的：设 DSH_TEST_SESSION_SHORT=<短id> 才会跑
const REAL_SHORT = String(process.env.DSH_TEST_SESSION_SHORT || '').trim()
const logFile = REAL_SHORT ? findSessionLogByPrefix(REAL_SHORT) : null
if (!logFile) {
  console.log('  ⏭ 找不到 28a7537f 的日志（跳过真实用例）')
} else {
  console.log('  日志：', logFile.split('/').slice(-2)[0])
  const all = readEvents(logFile, { limit: 50, maxChars: 200 })
  ok('真实会话：能读出轮数', () => assert.ok(all.windows >= 10, `windows=${all.windows}`))
  const turn0 = readEvents(logFile, { turnIndex: 0, limit: 50, maxChars: 200 })
  ok('turnIndex=0 取到第一轮的窗口，且以真用户消息开头', () => {
    assert.ok(turn0.events.length > 0)
    assert.equal(turn0.events[0].type, 'user/message')
    assert.equal(turn0.events[0].kind, 'user')
  })
  const tools = readEvents(logFile, { turnIndex: 0, types: ['tool/call', 'tool/result'], limit: 6, maxChars: 120 })
  ok('types 过滤生效（只剩 tool/call + tool/result）', () => {
    assert.ok(tools.events.length > 0)
    for (const e of tools.events) assert.ok(['tool/call', 'tool/result'].includes(e.type), e.type)
  })
  ok('真实数据的工具名可读（不是空）', () => {
    const call = tools.events.find((e) => e.type === 'tool/call')
    if (call) assert.ok(call.name && call.name.length > 0)
  })
  ok('分页：limit 生效且 truncated 标记正确', () => {
    const few = readEvents(logFile, { turnIndex: 0, limit: 2, maxChars: 80 })
    assert.equal(few.events.length, 2)
    assert.equal(few.truncated, few.total > 2)
  })
  ok('按 seq 范围取（from/to）', () => {
    const r = readEvents(logFile, { from: 20, to: 40, limit: 50, maxChars: 80 })
    for (const e of r.events) assert.ok(e.seq >= 20 && e.seq <= 40, `seq=${e.seq}`)
  })
}

console.log('\n[5] 明确失败与上限（2026-11-18 GPT 评审后加）')
if (logFile) {
  const miss = readEvents(logFile, { turnIndex: 999 })
  ok('指定轮次不存在 → ok:false，且报出会话实际轮数', () => {
    assert.equal(miss.ok, false, '不能悄悄退回全会话')
    assert.match(miss.error, /不在这份日志里/)
    assert.ok(miss.windows > 0)
    assert.deepEqual(miss.events, [])
  })
  const miss2 = readEvents(logFile, { userSeq: 999999 })
  ok('指定 userSeq 不存在 → 同样明确失败', () => assert.equal(miss2.ok, false))
  const big = readEvents(logFile, { turnIndex: 0, limit: 1, maxChars: 99999 })
  ok('maxChars 超过 4000 被夹住（描述承诺必须真执行）', () => {
    const e = big.events[0]
    if (e && e.text) assert.ok(e.text.length <= 4100, `得到 ${e.text.length}`)
  })
}
ok('summarizeEvent 的 maxChars 也有硬上限', () => {
  const s = summarizeEvent(TR(5, 'x'.repeat(9000)), { maxChars: 99999 })
  assert.ok(s.text.length <= 4100, `得到 ${s.text.length}`)
})

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { for (const f of fails) console.log('FAILED:', f.name, '\n', f.err); process.exit(1) }
