// self-test-takeover-estimate —— 收益估算口径（2026-11-18 修正）自测
// 核心验证 GPT 指出的两点：①最终回答内的 reasoning 不得计入可折；②分母必须是全部事件字符。
import assert from 'node:assert/strict'
import { estimateTakeover, ESTIMATE_POLICY_VERSION } from '../lib/takeover.js'
import { readSessionEvents } from '../lib/turns/session-log.js'

let pass = 0
const fails = []
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name) } catch (e) { fails.push({ name, err: e }); console.log('  ✗', name, '--', e.message) }
}

function makeSession(events) {
  const map = new Map(events.map((e) => [e.seq, e]))
  return { surface: { nodes: events.map((e) => e.seq) }, eventAt: (seq) => map.get(seq) }
}
const U = (seq, text) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const A = (seq, reasoning, text) => ({
  seq, type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: [
        ...(reasoning ? [{ type: 'reasoning', text: 'x'.repeat(reasoning) }] : []),
        ...(text ? [{ type: 'text', text }] : []),
      ],
    },
  },
})
const TC = (seq, args) => ({ seq, type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: args } })
const TR = (seq, n) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(n) }] } } })

console.log('\n[1] 合成用例：最终回答内的 reasoning 必须排除')
const synth = [
  U(1, '问题一'), A(2, 1000, ''), TC(3, '{"path":"a"}'), TR(4, 500), A(5, 2000, '最终答一'),
  U(6, '问题二'), A(7, 800, '最终答二'),
  U(8, '问题三'), A(9, 300, '最终答三'),
]
const est = estimateTakeover(makeSession(synth), { keepTurns: 1 })
ok('口径版本 = 2（账本里能区分新旧数据）', () => assert.equal(est.policyVersion, ESTIMATE_POLICY_VERSION))
ok('可折 reasoning 只含中间轨迹（1000），不含最终回答的 2000', () => {
  assert.equal(est.reasoningChars, 1000, `得到 ${est.reasoningChars}`)
})
ok('最终回答内被保留的 reasoning 单独记账（2000 + 800 = 2800）', () => {
  assert.equal(est.keptAnswerReasoningChars, 2800, `得到 ${est.keptAnswerReasoningChars}`)
})
ok('可折节点 = 纯 reasoning 节点 + tool/call + tool/result（3 个）', () => {
  assert.equal(est.foldableNodes, 3, `得到 ${est.foldableNodes}`)
})
ok('tool 字符不再乘 0.9 的"压摘要"系数（整节点替换＝全删）', () => {
  assert.equal(est.toolChars, 500)
})
ok('可折轮数 = 2（前两轮完整）', () => assert.equal(est.foldableTurns, 2))
ok('分母含用户正文（totalChars > 2000+800+1000+500 之和）', () => {
  assert.ok(est.totalChars > 4300, `得到 ${est.totalChars}`)
})
ok('savedChars 扣掉每轮一个标记的固定开销', () => {
  assert.equal(est.savedChars, 1000 + 500 - 2 * 120, `得到 ${est.savedChars}`)
})
ok('savedPct 是"占 cutoff 前全部输入"的百分比（不再是旧口径的 90%+）', () => {
  assert.ok(est.savedPct > 0 && est.savedPct < 60, `得到 ${est.savedPct}%`)
})

console.log('\n[2] 可折区里的未完成轮必须整轮跳过，且"有可见文本的中间节点"也折不掉')
// 轮0/轮1 各有：纯 reasoning 中间节点 + 有可见文本的中间节点 + 最终回答
const incomplete = [
  U(1, '问题一'), A(2, 400, ''), A(3, 150, '我先看看'), A(4, 200, '答一'),
  U(5, '问题二'), A(6, 400, ''), A(7, 200, '答二'),
  U(8, '问题三'), A(9, 300, ''),           // 轮2 进行中：只有问题 + 中间推理，没有可见回答
  U(10, '问题四'), A(11, 200, '答四'),
]
const est2 = estimateTakeover(makeSession(incomplete), { keepTurns: 1 })
ok('未完成轮不计入 foldableTurns（3 个可折轮里只有 2 个完整）', () => {
  assert.equal(est2.foldableTurns, 2, `得到 ${est2.foldableTurns}`)
})
ok('未完成轮的中间 reasoning 不计入（那个 300 字不能算）', () => {
  assert.equal(est2.reasoningChars, 400 + 400, `得到 ${est2.reasoningChars}`)
})
ok('有可见文本的中间节点整节点保留，它内嵌的 reasoning 单列（轮0 的 150）', () => {
  assert.equal(est2.keptInnerReasoningChars, 150, `得到 ${est2.keptInnerReasoningChars}`)
})
ok('可折节点只含纯 reasoning 节点（每轮 1 个，共 2 个）', () => {
  assert.equal(est2.foldableNodes, 2, `得到 ${est2.foldableNodes}`)
})

console.log('\n[3] 轮数不足 keepTurns 时全零')
const est3 = estimateTakeover(makeSession([U(1, 'a'), A(2, 100, 'b')]), { keepTurns: 13 })
ok('turns<=keepTurns → savedChars 为 0', () => {
  assert.equal(est3.turns, 1)
  assert.equal(est3.savedChars, 0)
  assert.equal(est3.savedPct, 0)
})
ok('空 session 不崩', () => {
  const e = estimateTakeover({ surface: { nodes: [] }, eventAt: () => undefined }, {})
  assert.equal(e.turns, 0)
})

console.log('\n[4] 真实会话：新口径必须比旧口径小（旧口径把最终回答的 reasoning 也算进去了）')
// 真实会话用例是可选的：设 DSH_TEST_SESSION_FILE 指向一个 session.v4.jsonl.zstd 才会跑
const FILE = process.env.DSH_TEST_SESSION_FILE || ''
let realOk = true
try {
  const { events } = readSessionEvents(FILE)
  const appendOnly = events.filter((e) => !e.surfaceOp || e.surfaceOp === 'append')
  const session = makeSession(appendOnly)
  const real = estimateTakeover(session, { keepTurns: 13 })

  // 旧口径复算：cutoff 前所有 assistant 的 reasoning + 所有 tool/result ×0.9
  const turns = []
  let cur = null
  for (const ev of appendOnly) {
    const kind = ev?.data?.source?.kind
    if (ev.type === 'user/message' && kind === 'user') { cur = { userSeq: ev.seq, seqs: [] }; turns.push(cur); continue }
    if (cur) cur.seqs.push(ev.seq)
  }
  const cutoff = turns[turns.length - 13].userSeq
  let oldReason = 0, oldTool = 0
  for (const ev of appendOnly) {
    if (ev.seq >= cutoff) continue
    const blocks = ev?.data?.message?.content
    if (ev.type === 'assistant/message' && Array.isArray(blocks)) {
      for (const b of blocks) if (b?.type === 'reasoning') oldReason += String(b.text ?? '').length
    }
    if (ev.type === 'tool/result' && Array.isArray(blocks)) {
      for (const b of blocks) oldTool += String(b?.text ?? '').length
    }
  }
  const oldSaved = oldReason + Math.round(oldTool * 0.9)

  ok(`真实会话读出 ${real.turns} 轮（>keepTurns）`, () => assert.ok(real.turns > 13))
  ok('新口径的可折 reasoning 明显小于旧口径（最终回答部分被排除）', () => {
    assert.ok(real.reasoningChars < oldReason, `新 ${real.reasoningChars} 应 < 旧 ${oldReason}`)
  })
  ok('保留的最终回答 reasoning 有实际体量（证明排除生效而不是没算）', () => {
    assert.ok(real.keptAnswerReasoningChars > 10000, `得到 ${real.keptAnswerReasoningChars}`)
  })
  ok('新口径 savedPct 落在合理区间（40%~70%，不再是旧口径的虚高）', () => {
    assert.ok(real.savedPct >= 40 && real.savedPct <= 70, `得到 ${real.savedPct}%`)
  })
  ok('分母是全部事件字符（远大于 assistants 内容）', () => {
    assert.ok(real.totalChars > oldReason + oldTool, `total=${real.totalChars} old=${oldReason + oldTool}`)
  })
  console.log(`  → 真实会话：${real.turns} 轮 / 可折 ${real.foldableTurns} 轮 ${real.foldableNodes} 节点`
    + ` / 省 ${real.savedChars} 字 = ${real.savedPct}% / 旧口径会报 ${Math.round(100 * oldSaved / (oldReason + oldTool))}%`)
} catch (e) {
  realOk = false
  console.log('  ⏭ 真实会话不可达，跳过：', e.message)
}

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { for (const f of fails) console.log('FAILED:', f.name, '\n', f.err); process.exit(1) }
