/**
 * 自测：统一抽取合同（lib/turns/extract-contract.js）
 * 覆盖移植指南 §8「数据合同」六条 + 隐私 + 与 store 的端到端衔接。
 * 跑法：node scripts/self-test-extract-contract.mjs（离线，不调任何 LLM）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXTRACTION_SCHEMA, EXTRACTION_TOOL, EXTRACTION_TOOL_NAME, EXTRACT_SYSTEM_PROMPT,
  validateExtraction, assertExtractionContract, parseExtraction,
  normalizeTurnContent, buildExtractUserPrompt, buildExtractMessages,
} from '../lib/turns/extract-contract.js'
import { openTurnsDb, turnsDbPathOf } from '../lib/turns/schema.js'
import { upsertTurn, replaceTriples, getTriplesForTurn, statsOf } from '../lib/turns/store.js'

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
function notOk(value, label = '') { if (value) throw new Error(`${label} 期望假值，实际 ${JSON.stringify(value)}`) }
function throwsWith(fn, label = '') {
  try { fn() } catch (error) { return error }
  throw new Error(`${label} 应该抛错但没有`)
}

const valid = { summary: '轮次记忆库地基已落地。', outcome: 'completed', triples: [{ subject: '轮次记忆库', predicate: '落地', object: '地基' }] }
const SENSITIVE = '银行卡密码是998877'

console.log('\n【合同校验：指南 §8 数据合同】')
t('合法对象通过', () => eq(validateExtraction(valid).ok, true))
t('triples: [] 合法', () => eq(validateExtraction({ ...valid, triples: [] }).ok, true))
t('缺 summary → 失败', () => eq(validateExtraction({ outcome: 'completed', triples: [] }).ok, false))
t('缺 outcome → 失败', () => eq(validateExtraction({ summary: 'x', triples: [] }).ok, false))
t('缺 triples → 失败', () => eq(validateExtraction({ summary: 'x', outcome: 'completed' }).ok, false))
t('outcome 不在枚举 → 失败', () => eq(validateExtraction({ ...valid, outcome: 'done' }).ok, false))
t('多余顶层字段 → 失败', () => eq(validateExtraction({ ...valid, extra: 1 }).ok, false))
t('triple 缺 subject → 失败', () => eq(validateExtraction({ ...valid, triples: [{ predicate: 'p', object: 'o' }] }).ok, false))
t('triple 缺 predicate → 失败', () => eq(validateExtraction({ ...valid, triples: [{ subject: 's', object: 'o' }] }).ok, false))
t('triple 缺 object → 失败', () => eq(validateExtraction({ ...valid, triples: [{ subject: 's', predicate: 'p' }] }).ok, false))
t('triple 内多余字段 → 失败', () => eq(validateExtraction({ ...valid, triples: [{ subject: 's', predicate: 'p', object: 'o', note: 'x' }] }).ok, false))
t('triple 项是字符串 → 失败', () => eq(validateExtraction({ ...valid, triples: ['s-p-o'] }).ok, false))
t('summary 空串 → 失败', () => eq(validateExtraction({ ...valid, summary: '' }).ok, false))
t('summary 不是字符串 → 失败', () => eq(validateExtraction({ ...valid, summary: 42 }).ok, false))
t('triples 不是数组 → 失败', () => {
  eq(validateExtraction({ ...valid, triples: {} }).ok, false)
  eq(validateExtraction({ ...valid, triples: 'x' }).ok, false)
})
t('triple 字段空串 → 失败', () => eq(validateExtraction({ ...valid, triples: [{ subject: '', predicate: 'p', object: 'o' }] }).ok, false))
t('根是数组 → 失败', () => eq(validateExtraction([valid]).ok, false))
t('根是 null / 字符串 / 数字 → 失败', () => {
  eq(validateExtraction(null).ok, false)
  eq(validateExtraction('{}').ok, false)
  eq(validateExtraction(7).ok, false)
})

console.log('\n【fail closed 与隐私】')
t('assertExtractionContract 失败抛 TypeError', () => {
  const error = throwsWith(() => assertExtractionContract({ summary: 'x' }), 'assert')
  ok(error instanceof TypeError, 'TypeError')
})
t('错误信息不回显模型原文（隐私）', () => {
  const error = throwsWith(() => assertExtractionContract({ summary: SENSITIVE, outcome: 'nope', triples: [] }), 'assert')
  notOk(error.message.includes('998877'), `错误里不应含敏感内容：${error.message}`)
  notOk(error.message.includes('银行卡'), '错误里不应含模型措辞')
})
t('校验 errors 只含路径与原因', () => {
  const { errors } = validateExtraction({ summary: SENSITIVE, outcome: 'nope', triples: [] })
  notOk(errors.join(' ').includes('998877'), 'errors 不应含原文')
  ok(errors.some((e) => e.includes('/outcome')), '应带路径')
})

console.log('\n【parseExtraction：只 parse + 校验】')
t('合法 JSON 字符串 → 结构化结果', () => {
  const parsed = parseExtraction(JSON.stringify(valid))
  eq(parsed.summary, valid.summary)
  eq(parsed.outcome, 'completed')
  eq(parsed.triples, valid.triples)
})
t('空字符串 → 抛错（没有工具参数）', () => throwsWith(() => parseExtraction(''), 'empty'))
t('非 JSON 正文 → 抛错（正文不能当结构化结果）', () => {
  const error = throwsWith(() => parseExtraction('好的，我已完成抽取。'), 'prose')
  ok(error.message.includes('JSON'), '错误应说明不是 JSON')
})
t('JSON 数组 → 抛错', () => throwsWith(() => parseExtraction('[1,2]'), 'array'))
t('JSON 缺字段 → 抛错', () => throwsWith(() => parseExtraction('{"summary":"x"}'), 'missing'))
t('多余字段 → 抛错（不做 repair）', () => throwsWith(() => parseExtraction(JSON.stringify({ ...valid, extra: 1 })), 'extra'))
t('parse 抛错也不回显模型原文', () => {
  const error = throwsWith(() => parseExtraction(JSON.stringify({ summary: SENSITIVE, outcome: 'bogus', triples: [] })), 'sensitive')
  notOk(error.message.includes('998877'), '错误里不应含敏感内容')
})
t('返回的 triples 是浅拷贝（不共享引用）', () => {
  const input = JSON.parse(JSON.stringify(valid))
  const parsed = parseExtraction(JSON.stringify(input))
  ok(parsed.triples[0] !== input.triples[0], '不应是同一对象')
})

console.log('\n【provider-facing 合同】')
t('工具名是 submit_result', () => eq(EXTRACTION_TOOL_NAME, 'submit_result'))
t('工具的 parameters 就是合同 schema', () => ok(EXTRACTION_TOOL.parameters === EXTRACTION_SCHEMA))
t('三字段全部必填且扁平', () => {
  eq(EXTRACTION_SCHEMA.required, ['summary', 'outcome', 'triples'])
  eq(EXTRACTION_SCHEMA.additionalProperties, false)
})
t('outcome enum 与 store 的枚举一致', () => {
  eq(EXTRACTION_SCHEMA.properties.outcome.enum, ['completed', 'partial', 'failed', 'informational', 'unknown'])
})
t('triples items 要求三字段、禁多余字段', () => {
  const items = EXTRACTION_SCHEMA.properties.triples.items
  eq(items.required, ['subject', 'predicate', 'object'])
  eq(items.additionalProperties, false)
})
t('工具描述点明"没有关系时用空数组、不要输出正文"', () => {
  ok(EXTRACTION_TOOL.description.includes('[]'), '空数组')
  ok(EXTRACTION_TOOL.description.includes('不要输出正文'), '禁止正文')
})

console.log('\n【提示词组装】')
t('system prompt 含关键原则', () => {
  ok(EXTRACT_SYSTEM_PROMPT.includes('Current Turn 是本轮唯一事实来源'), '唯一事实来源')
  ok(EXTRACT_SYSTEM_PROMPT.includes('只调用 submit_result 一次'), '一次调用')
  ok(EXTRACT_SYSTEM_PROMPT.includes('没有明确关系时使用空数组'), '空数组')
  for (const outcome of ['completed', 'partial', 'failed', 'informational', 'unknown']) {
    ok(EXTRACT_SYSTEM_PROMPT.includes(outcome), outcome)
  }
})
t('user prompt 含两个标记段', () => {
  const text = buildExtractUserPrompt({ userText: '问', answerText: '答', priorSummaries: [] })
  ok(text.startsWith('<Previous Turn Summaries>'), '开头')
  ok(text.includes('<Current Turn>'), 'Current Turn')
})
t('无前轮摘要 → 显示（无）', () => {
  ok(buildExtractUserPrompt({ userText: 'q', answerText: 'a' }).includes('（无）'))
})
t('有前轮摘要 → JSON 数组', () => {
  const text = buildExtractUserPrompt({ userText: 'q', answerText: 'a', priorSummaries: ['第一轮摘要', '  ', '第二轮摘要'] })
  ok(text.includes('["第一轮摘要","第二轮摘要"]'), `实际：${text.slice(0, 120)}`)
})
t('用户与回答按序出现并用 --- 分隔', () => {
  const text = buildExtractUserPrompt({ userText: '我的问题', answerText: '我的回答' })
  ok(text.indexOf('用户：我的问题') < text.indexOf('回答：我的回答'), '顺序')
  ok(text.includes('\n\n---\n\n'), '分隔线')
})
t('buildExtractMessages → [system, user]', () => {
  const messages = buildExtractMessages({ userText: 'q', answerText: 'a' })
  eq(messages.map((m) => m.role), ['system', 'user'])
  eq(messages[0].content, EXTRACT_SYSTEM_PROMPT)
})

console.log('\n【内容归一化】')
t('字符串直通', () => eq(normalizeTurnContent('你好'), '你好'))
t('content 块数组只看 text', () => {
  eq(normalizeTurnContent([{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }]), 'A\nB')
})
t('嵌套 message / content 递归', () => {
  eq(normalizeTurnContent({ message: { content: [{ type: 'text', text: '深' }] } }), '深')
})
t('null / 非对象 → 空串或字符串化', () => {
  eq(normalizeTurnContent(null), '')
  eq(normalizeTurnContent(undefined), '')
  eq(normalizeTurnContent(12), '12')
})

console.log('\n【端到端：parse → store 入库】')
t('抽取结果可直接入库并写成 SPO', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const workspace = path.join(here, '..', '_tmp', 'extract-selftest', 'run-' + Date.now())
  fs.mkdirSync(workspace, { recursive: true })
  const db = openTurnsDb(workspace)
  const parsed = parseExtraction(JSON.stringify({
    summary: '轮次记忆库地基已落地并提交。',
    outcome: 'completed',
    triples: [
      { subject: '轮次记忆库', predicate: '提交为', object: '9f05b9c' },
      { subject: '宿主轮次投影', predicate: '提交为', object: 'faaad75' },
    ],
  }))
  const turn = upsertTurn(db, {
    sessionId: 'session-selftest', turnIndex: 0, summary: parsed.summary, outcome: parsed.outcome,
    userSeq: 0, answerSeq: 1, userText: '继续吧', answerText: '已完成',
  })
  replaceTriples(db, turn.id, 'session-selftest', parsed.triples)
  eq(getTriplesForTurn(db, turn.id).length, 2)
  eq(statsOf(db).turns, 1)
  eq(getTriplesForTurn(db, turn.id)[0].predicate, '提交为')
  db.close()
  ok(fs.existsSync(turnsDbPathOf(workspace)), '库文件存在')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
