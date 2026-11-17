// self-test-surface-project —— 真投影的选段与执行（不碰真实会话，全部合成）
import assert from 'node:assert/strict'
import { splitSurfaceTurns, selectFoldSegment, applyFoldSegment, planProjection, nodeFoldInfo } from '../lib/turns/surface-project.js'

let pass = 0
const fails = []
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name) } catch (e) { fails.push({ name, err: e }); console.log('  ✗', name, '--', e.message) }
}

const U = (seq, text) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const A = (seq, reasoning, text) => ({
  seq, type: 'assistant/message',
  data: { message: { role: 'assistant', content: [
    ...(reasoning ? [{ type: 'reasoning', text: 'x'.repeat(reasoning) }] : []),
    ...(text ? [{ type: 'text', text }] : []),
  ] } },
})
const TR = (seq, n) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(n) }] } } })

function makeSession(events) {
  const map = new Map(events.map((e) => [e.seq, e]))
  const appended = []
  return {
    header: { id: 'session-abcdef12-1111-2222-3333-444444444444' },
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (s) => map.get(s),
    append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: 9000 + appended.length } },
    _appended: appended,
  }
}

// 3 轮，keepTurns=1 → 可折区 = 轮0、轮1
const base = [
  U(1, '问题一'), A(2, 500, ''), TR(3, 300), A(4, 200, '答一'),
  U(5, '问题二'), A(6, 500, '中途说话'), TR(7, 300), A(8, 200, '答二'),
  U(9, '问题三'), A(10, 200, '答三'),
]

console.log('\n[1] splitSurfaceTurns —— 与估算同口径')
ok('切成 3 轮，answerSeq 取最后一个有可见文本的 assistant', () => {
  const t = splitSurfaceTurns(makeSession(base))
  assert.equal(t.length, 3)
  assert.equal(t[0].answerSeq, 4)
  assert.equal(t[1].answerSeq, 8)
})
ok('插件注入的 user/message 不开新轮', () => {
  const t = splitSurfaceTurns(makeSession([
    { seq: 1, type: 'user/message', data: { source: { kind: 'plugin:meow-memory' }, content: [{ type: 'text', text: '注入' }] } },
    U(2, '问题'), A(3, 100, '答'),
  ]))
  assert.equal(t.length, 1)
})

console.log('\n[2] selectFoldSegment —— 红线：中间夹可见文本就整轮放弃')
ok('轮0（中间全可折）可被选中', () => {
  const seg = selectFoldSegment(makeSession(base), { keepTurns: 1, turnIndex: 0 })
  assert.equal(seg.ok, true)
  assert.deepEqual(seg.shadowedSeqs, [2, 3])
  assert.equal(seg.start, 2)
  assert.equal(seg.end, 3)
})
ok('轮1 中间有可见文本（seq 6）→ 明确拒绝而不是硬折', () => {
  const seg = selectFoldSegment(makeSession(base), { keepTurns: 1, turnIndex: 1 })
  assert.equal(seg.ok, false)
  assert.match(seg.reason, /没有可折的中间轨迹/)
})
ok('缺省不指定 turn 时，自动跳过不合格的轮，选最早可折的', () => {
  const seg = selectFoldSegment(makeSession(base), { keepTurns: 1 })
  assert.equal(seg.ok, true)
  assert.equal(seg.turnIndex, 0)
})
ok('轮数不超 keepTurns → 拒绝', () => {
  const seg = selectFoldSegment(makeSession(base), { keepTurns: 5 })
  assert.equal(seg.ok, false)
  assert.match(seg.reason, /没有可折区/)
})
ok('指定保留区里的轮 → 拒绝（不许折最近 N 轮）', () => {
  const seg = selectFoldSegment(makeSession(base), { keepTurns: 1, turnIndex: 2 })
  assert.equal(seg.ok, false)
  assert.match(seg.reason, /不在可折区/)
})
ok('未完成轮（没有可见回答）跳过', () => {
  const ev = [U(1, '问题一'), A(2, 300, ''), U(3, '问题二'), A(4, 200, '答')]
  const seg = selectFoldSegment(makeSession(ev), { keepTurns: 1 })
  assert.equal(seg.ok, false) // 轮0 没有 answerSeq，整轮跳过
})
ok('只有 Q 和 A、没有中间轨迹的轮跳过', () => {
  const ev = [U(1, '问题一'), A(2, 200, '答一'), U(3, '问题二'), A(4, 200, '答二')]
  const seg = selectFoldSegment(makeSession(ev), { keepTurns: 1 })
  assert.equal(seg.ok, false)
})

console.log('\n[3] applyFoldSegment —— 先审计后替换，参数必须对')
const meter = (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, heuristicTokens: 50 })) })
const seg0 = selectFoldSegment(makeSession(base), { keepTurns: 1, turnIndex: 0 })

ok('成功路径：两次 append，顺序是先 prune 后替换', () => {
  const s = makeSession(base)
  const r = applyFoldSegment(s, { measure: meter }, seg0)
  assert.equal(r.committed, true)
  assert.equal(s._appended.length, 2)
  assert.equal(s._appended[0].type, 'compaction/prune')
  assert.equal(s._appended[1].type, 'user/message')
})
ok('审计事件带 shadowedRange / shadowedSeqs / shadowedTokenCount', () => {
  const s = makeSession(base)
  applyFoldSegment(s, { measure: meter }, seg0)
  const d = s._appended[0].data
  assert.deepEqual(d.shadowedRange, { start: 2, end: 3 })
  assert.deepEqual(d.shadowedSeqs, [2, 3])
  assert.equal(d.shadowedTokenCount, 100) // 两个 seq × 50
})
ok('替换用 surfaceOp {op:replace, startSeq, endSeq}（不能写成 start/end）', () => {
  const s = makeSession(base)
  applyFoldSegment(s, { measure: meter }, seg0)
  const opt = s._appended[1].opts
  assert.deepEqual(opt.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 })
  assert.equal('start' in opt.surfaceOp, false)
})
ok('sourceEventSeqs 覆盖审计 seq + 全部被遮蔽 seq', () => {
  const s = makeSession(base)
  applyFoldSegment(s, { measure: meter }, seg0)
  assert.deepEqual(s._appended[1].opts.sourceEventSeqs, [9001, 2, 3])
})
ok('标记里写明"用什么取回"（recall_events + 会话短 id + 轮次）', () => {
  const s = makeSession(base)
  applyFoldSegment(s, { measure: meter }, seg0)
  const text = s._appended[1].data.content[0].text
  assert.match(text, /recall_events\(\{ session: "abcdef12", turn: 0 \}\)/)
  assert.match(text, /dsh-memory-semantic-fold/)
})
ok('标记 source 是 v4 producer-owned 形态（plugin:<包名>）', () => {
  const s = makeSession(base)
  applyFoldSegment(s, { measure: meter }, seg0)
  assert.equal(s._appended[1].data.source.kind, 'plugin:dsh-memory-semantic')
})
ok('tokenMeter 缺失 → 整轮放弃，一次 append 都不发', () => {
  const s = makeSession(base)
  const r = applyFoldSegment(s, null, seg0)
  assert.equal(r.committed, false)
  assert.match(r.error, /tokenMeter/)
  assert.equal(s._appended.length, 0)
})
ok('某个 seq 没价格 → 整轮放弃（不半折）', () => {
  const s = makeSession(base)
  const r = applyFoldSegment(s, { measure: () => ({ nodes: [{ seq: 2, heuristicTokens: 50 }] }) }, seg0)
  assert.equal(r.committed, false)
  assert.match(r.error, /seq 3/)
  assert.equal(s._appended.length, 0)
})
ok('替换 append 抛错 → committed=false 且 error 说明"审计已写"', () => {
  const s = makeSession(base)
  let n = 0
  s.append = (type, data, opts) => {
    n += 1
    if (n === 2) throw new Error('surface append rejected')
    return { seq: 9001 }
  }
  const r = applyFoldSegment(s, { measure: meter }, seg0)
  assert.equal(r.committed, false)
  assert.match(r.error, /审计已写/)
})
ok('session.append 不可用 → 明确报错', () => {
  const r = applyFoldSegment({ surface: { nodes: [] } }, { measure: meter }, seg0)
  assert.equal(r.committed, false)
  assert.match(r.error, /append 不可用/)
})

console.log('\n[4] GPT 评审指出的三个边界（2026-11-18 加固）')
const AwithCalls = (seq, text, calls) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }, ...calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: '{}' }))] } } })
// 4.1 工具依赖完整性：带调用的 assistant 保留 → 它的结果不许被单独折掉
const danglingEvents = [
  U(1, '问题一'),
  AwithCalls(2, '我先读一下配置', [{ id: 'c1', name: 'read' }]),
  TR(4, 200),
  A(5, 0, '最终答一'),
  U(6, '问题二'), A(7, 0, '答二'),
]
const pd = planProjection(makeSession(danglingEvents), { keepTurns: 1, turnIndex: 0 })
ok('不制造悬空调用（保留调用 ⇒ 结果也保留）', () => {
  const folded = new Set((pd.plan || []).flatMap((x) => x.segments).flatMap((g) => g.shadowedSeqs))
  assert.equal(folded.has(4), false, '结果 seq 4 不该被折；实际折了 [' + [...folded].join(',') + ']')
})
ok('依赖组里只要有一个保留节点，整组都不折', () => {
  const blocked = nodeFoldInfo(danglingEvents[1])
  assert.equal(blocked.foldable, false)
  assert.deepEqual(blocked.callIds, ['c1'])
})

// 4.2 按表面位置切片：seq 100 的标记位置在 seq 3 之前
const markEv = { seq: 100, type: 'user/message', data: { source: { kind: 'plugin:x' }, content: [{ type: 'text', text: '已有折叠标记' }] } }
const ev2 = [U(1, 'q1'), A(2, 500, ''), TR(3, 200), A(5, 0, '答一'), U(6, 'q2'), A(7, 0, '答二'), markEv]
const map2 = new Map(ev2.map((e) => [e.seq, e]))
const order2 = [1, 2, 100, 3, 5, 6, 7]
const s2 = { header: { id: 'session-abcdef12-1' }, surface: { nodes: order2 }, eventAt: (q) => map2.get(q) }
const p2 = planProjection(s2, { keepTurns: 1, turnIndex: 0 })
ok('选出的段必须与表面位置连续一致（不跨过中间的保护标记）', () => {
  for (const seg of (p2.plan || []).flatMap((x) => x.segments)) {
    const i0 = order2.indexOf(seg.start)
    const i1 = order2.indexOf(seg.end)
    const between = order2.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)
    assert.deepEqual(between, seg.shadowedSeqs, '段 ' + seg.start + '~' + seg.end + ' 与表面区间 ' + between.join(',') + ' 不一致')
  }
})

// 4.3 未知块类型（图片等）一律保留
ok('含图片块的 assistant 节点不可折', () => {
  const ev = { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'image', url: 'x' }] } } }
  assert.equal(nodeFoldInfo(ev).foldable, false)
  assert.match(nodeFoldInfo(ev).why, /未知块/)
})

// 4.4 计划里带真实标记文本，长度即真实开销
ok('计划里每段的 marker 是真实文本，markerChars 等于它长度', () => {
  const segs = (pd.plan || []).flatMap((x) => x.segments)
  if (segs.length) {
    for (const g of segs) {
      assert.ok(g.marker.length > 100, '标记不该是占位符')
      assert.equal(g.markerChars, g.marker.length)
    }
  }
})


console.log('\n[5] 段边界工具组校验 + 标记 ID 唯一（2026-11-19 GPT 评审后加）')
const INJ5 = (seq) => ({ seq, type: 'user/message', data: { source: { kind: 'plugin:meow-memory' }, content: [{ type: 'text', text: '注入' }] } })
const Acall5 = (seq, callId) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] } } })
// 调用侧两个节点（assistant + reasoning），中间被必须保留的注入打断，结果侧只剩一个节点
const crossEvs = [U(1, 'q1'), Acall5(2, 'c1'), A(3, 200, ''), INJ5(4), TR(5, 200), A(6, 0, 'a1'), U(7, 'q2'), A(8, 0, 'a2')]
const crossSession = makeSession(crossEvs)
const crossPlan = planProjection(crossSession, { keepTurns: 1, turnIndex: 0 })
ok('工具组被保护节点劈开时整组保留，绝不只折调用留结果', () => {
  const folded = new Set((crossPlan.plan || []).flatMap((x) => x.segments).flatMap((g) => g.shadowedSeqs))
  assert.equal(folded.has(2) && !folded.has(5), false, '只折了调用 seq2 而没折结果 seq5 → 悬空')
  assert.equal(!folded.has(2) && folded.has(5), false, '只折了结果 seq5 而没折调用 seq2')
})
ok('跨段工具组导致的放弃会写明原因', () => {
  assert.equal(crossPlan.ok, false, '这一轮应该整组保留、没有可用段')
})

// 同一轮里有两个合法段 → 标记 ID 必须不同
const twoSegEvs = [U(1, 'q1'), A(2, 200, ''), A(3, 200, ''), A(4, 100, '中间话'), A(5, 200, ''), A(6, 200, ''), A(7, 0, 'a1'), U(8, 'q2'), A(9, 0, 'a2')]
const twoSegSession = makeSession(twoSegEvs)
const twoSegPlan = planProjection(twoSegSession, { keepTurns: 1, turnIndex: 0 })
ok('同一轮里能分出两段', () => {
  assert.equal(twoSegPlan.ok, true, JSON.stringify(twoSegPlan).slice(0, 200))
  assert.equal(twoSegPlan.plan[0].segments.length, 2, JSON.stringify(twoSegPlan.plan[0].segments.map((g) => g.shadowedSeqs)))
})
ok('两段各生成一条标记，消息 ID 不同（撞 id 会被宿主当重复消息）', () => {
  const ids = new Set()
  const s2 = makeSession(twoSegEvs)
  for (const seg of twoSegPlan.plan[0].segments) {
    const r = applyFoldSegment(s2, { measure: (x) => ({ nodes: x.surface.nodes.map((seq) => ({ seq, heuristicTokens: 10 })) }) }, { ...seg, turnIndex: 0, userSeq: 1, answerSeq: 7 })
    assert.equal(r.committed, true, r.error || '')
    ids.add(s2._appended[s2._appended.length - 1].data.id)
  }
  assert.equal(ids.size, 2, '两条标记的 id 应不同：' + [...ids].join(' | '))
})
console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { for (const f of fails) console.log('FAILED:', f.name, '\n', f.err); process.exit(1) }
