/**
 * 自测：抽取运行器（lib/turns/extract-runner.js）
 * 跑法：node scripts/self-test-extract-runner.mjs（离线，用假 chunk 流，不调用任何模型）
 */
import {
  collectStream, pickExtractionRaw, runExtraction, stripCodeFence, streamOf,
} from '../lib/turns/extract-runner.js'

let pass = 0
let fail = 0
const failures = []
function t(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    fail += 1
    failures.push(name + ' → 异步用例必须放进 asyncTests')
    console.log('  ✗', name, '→ 异步用例不能进同步 t()')
    return
  }
  try { fn(); pass += 1; console.log('  ✓', name) }
  catch (error) { fail += 1; failures.push(name + ' → ' + error.message); console.log('  ✗', name, '→', error.message) }
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label} 期望 ${b}，实际 ${a}`)
}
function ok(value, label = '') { if (!value) throw new Error(`${label} 期望真值，实际 ${JSON.stringify(value)}`) }
function notOk(value, label = '') { if (value) throw new Error(`${label} 期望假值`) }

const VALID = JSON.stringify({
  summary: '轮次记忆库地基已落地。',
  outcome: 'completed',
  triples: [{ subject: '轮次记忆库', predicate: '落地', object: '地基' }],
})
const SENSITIVE = '银行卡密码是998877'

/* 假 chunk 流：模拟 DSH 的 StreamChunk 序列 */
const toolCallChunks = (argChunks, { name = 'submit_result', id = 'call_1' } = {}) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  ...argChunks.map((argumentsDelta) => ({ type: 'tool-call-delta', index: 0, id, name, argumentsDelta })),
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argChunks.join('') } },
  { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const textChunks = (text) => [
  { type: 'reasoning-delta', index: 0, text: '让我想想……' },
  { type: 'text-delta', index: 1, text },
  { type: 'usage', usage: { inputTokens: 1200, outputTokens: 800 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

console.log('\n【流收集】')
t('stripCodeFence 剥 ```json 围栏', () => {
  eq(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}')
  eq(stripCodeFence('{"a":1}'), '{"a":1}')
  eq(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}')
})
t('pickExtractionRaw 优先取 submit_result', () => {
  const picked = pickExtractionRaw({ toolCalls: [{ id: 'x', name: 'other', arguments: '{}' }, { id: 'y', name: 'submit_result', arguments: '{"a":1}' }], text: 'ignored' })
  eq(picked, { raw: '{"a":1}', via: 'tool' })
})
t('没有工具调用但有正文 → via content', () => {
  eq(pickExtractionRaw({ toolCalls: [], text: '```json\n{"a":1}\n```' }), { raw: '{"a":1}', via: 'content' })
})
t('都没有 → null', () => eq(pickExtractionRaw({ toolCalls: [], text: '   ' }), null))

const asyncTests = [
  ['tool-call-delta 多段拼成完整参数', async () => {
    const collected = await collectStream(streamOf(toolCallChunks([VALID.slice(0, 20), VALID.slice(20)]))())
    eq(collected.toolCalls.length, 1)
    eq(collected.toolCalls[0].arguments, VALID)
    eq(collected.finishReason, 'tool-calls')
    eq(collected.usage.outputTokens, 300)
  }],
  ['block-end 的完整 block 覆盖 delta 结果', async () => {
    const chunks = [
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'submit_result', argumentsDelta: '{"broken' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'submit_result', arguments: VALID } },
    ]
    const collected = await collectStream(streamOf(chunks)())
    eq(collected.toolCalls[0].arguments, VALID)
  }],
  ['文本流：reasoning 不进 text', async () => {
    const collected = await collectStream(streamOf(textChunks('{"summary":"x","outcome":"unknown","triples":[]}'))())
    eq(collected.text, '{"summary":"x","outcome":"unknown","triples":[]}')
    ok(collected.reasoning.includes('让我想想'), 'reasoning 单独收集')
  }],
  ['空流 / 脏 chunk 不崩', async () => {
    const collected = await collectStream(streamOf([null, undefined, {}, { type: 'unknown-type' }])())
    eq([collected.text, collected.toolCalls.length, collected.usage, collected.finishReason], ['', 0, null, null])
  }],
  ['runExtraction：走工具 → 结构化结果', async () => {
    const out = await runExtraction({ stream: streamOf(toolCallChunks([VALID])) })
    ok(out.ok, '应成功')
    eq(out.via, 'tool')
    eq(out.result.outcome, 'completed')
    eq(out.result.triples.length, 1)
    eq(out.usage.inputTokens, 1200)
  }],
  ['runExtraction：没走工具但正文是 JSON → 同样成功', async () => {
    const out = await runExtraction({ stream: streamOf(textChunks('```json\n' + VALID + '\n```')) })
    ok(out.ok, '应成功')
    eq(out.via, 'content')
    eq(out.result.summary, '轮次记忆库地基已落地。')
  }],
  ['runExtraction：正文是散文 → fail closed', async () => {
    const out = await runExtraction({ stream: streamOf(textChunks('好的，我已完成抽取。')) })
    notOk(out.ok, '应失败')
    ok(out.error.includes('合同校验失败') || out.error.includes('JSON'), `错误信息：${out.error}`)
  }],
  ['runExtraction：合同不满足 → 失败且不回显原文（隐私）', async () => {
    const bad = JSON.stringify({ summary: SENSITIVE, outcome: 'bogus', triples: [] })
    const out = await runExtraction({ stream: streamOf(toolCallChunks([bad])) })
    notOk(out.ok, '应失败')
    notOk(out.error.includes('998877'), `错误里不应含模型原文：${out.error}`)
  }],
  ['runExtraction：空流 → 失败但不崩', async () => {
    const out = await runExtraction({ stream: streamOf([]) })
    notOk(out.ok, '应失败')
    ok(out.error.includes('既没调用工具'), out.error)
  }],
  ['runExtraction：流本身抛错 → 失败但不崩', async () => {
    const out = await runExtraction({ stream: async function* () { throw new Error('网络断了') } })
    notOk(out.ok, '应失败')
    ok(out.error.includes('流式调用失败'), out.error)
  }],
  ['runExtraction：缺 stream 函数 → 抛类型错误', async () => {
    let threw = false
    try { await runExtraction({}) } catch { threw = true }
    ok(threw, '应抛错')
  }],
]
for (const [name, fn] of asyncTests) {
  try { await fn(); pass += 1; console.log('  ✓', name) }
  catch (error) { fail += 1; failures.push(name + ' → ' + error.message); console.log('  ✗', name, '→', error.message) }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
