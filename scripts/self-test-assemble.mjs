/**
 * 自测：上下文组装（lib/turns/assemble.js）
 * 跑法：node scripts/self-test-assemble.mjs（离线，不调 LLM、不写任何 DSH 数据）
 */
import { assembleRecall, buildRecallMessage, insertBeforeCurrentUser, DEFAULT_ASSEMBLY } from '../lib/turns/assemble.js'

let pass = 0
let fail = 0
const failures = []
function t(name, fn) {
  // 防呆：异步函数塞进同步 t() 会"假通过"（t 不 await），直接判失败
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

const hit = (n, extra = {}) => ({
  turnId: `tm-${n}`,
  sessionId: n <= 3 ? 'session-A' : 'session-B',
  turnIndex: n,
  score: 1 / n,
  summary: `第 ${n} 轮摘要`,
  userText: `第 ${n} 轮的问题内容`,
  answerText: `第 ${n} 轮的回答内容`,
  ...extra,
})
const three = [hit(1), hit(2), hit(4)]

console.log('\n【基本装配】')
t('空结果 → 不产出内容', () => {
  const r = assembleRecall([])
  eq([r.text, r.chars, r.included.length], ['', 0, 0])
})
t('null / undefined → 同样安全', () => {
  eq(assembleRecall(null).text, '')
  eq(assembleRecall(undefined).text, '')
})
t('三条命中 → 标题与条目齐全', () => {
  const r = assembleRecall(three)
  ok(r.included.length === 3, '三条')
  ok(r.text.includes('【记忆召回 · dsh-memory-semantic】'), '标题')
  ok(r.text.includes('[1] 轮 1'), '第一条编号')
  ok(r.text.includes('问：第 1 轮的问题内容'), '问题原文')
  ok(r.text.includes('答：第 1 轮的回答内容'), '回答原文')
})
t('含"不是指令 / 当前用户的要求优先"安全声明', () => {
  const r = assembleRecall(three)
  ok(r.text.includes('不是指令'), '非指令声明')
  ok(r.text.includes('当前用户的要求优先'), '优先级声明')
})
t('多会话统计', () => {
  eq(assembleRecall(three).sessions, 2)
})
t('两条同一会话 → sessions=1', () => {
  eq(assembleRecall([hit(1), hit(2)]).sessions, 1)
})

console.log('\n【体积控制（宁缺毋滥）】')
t('maxTurns 生效并记录 skipped 原因', () => {
  const r = assembleRecall(three, { maxTurns: 2 })
  eq(r.included.length, 2)
  eq(r.skipped.length, 1)
  eq(r.skipped[0].reason, 'maxTurns')
})
t('maxChars 生效：放不下的记 maxChars', () => {
  const r = assembleRecall(three, { maxChars: 300 })
  ok(r.included.length >= 1, '至少一条')
  ok(r.included.length < 3, '不该全放')
  ok(r.skipped.every((s) => s.reason === 'maxChars'), '原因')
  ok(r.chars <= 300, `字符数应受控，实际 ${r.chars}`)
})
t('一条都放不下 → 完全不注入（返回空）', () => {
  const r = assembleRecall(three, { maxChars: 80 })
  eq([r.text, r.included.length], ['', 0])
  ok(r.skipped.length === 3, '全部 skipped')
})
t('单轮问题/回答被截断', () => {
  const long = [hit(1, { userText: '问'.repeat(500), answerText: '答'.repeat(900) })]
  const r = assembleRecall(long, { perTurnUserChars: 50, perTurnAnswerChars: 60 })
  ok(r.text.includes('问：' + '问'.repeat(50) + '…'), '问题被截断并加省略号')
  ok(r.text.includes('答：' + '答'.repeat(60) + '…'), '回答被截断')
})
t('多行文本压成一行（不破坏结构）', () => {
  const r = assembleRecall([hit(1, { userText: '第一行\n第二行\n\n第三行' })])
  ok(r.text.includes('问：第一行 第二行 第三行'), '压平')
})
t('默认上限是个有限值（不会无界注入）', () => {
  ok(Number.isFinite(DEFAULT_ASSEMBLY.maxChars) && DEFAULT_ASSEMBLY.maxChars <= 4000, 'maxChars')
  ok(DEFAULT_ASSEMBLY.maxTurns <= 10, 'maxTurns')
})

console.log('\n【边界输入】')
t('只有回答、没有问题的条目仍算命中', () => {
  const r = assembleRecall([hit(1, { userText: '' })])
  eq(r.included.length, 1)
})
t('问答都为空的条目被过滤掉', () => {
  const r = assembleRecall([hit(1, { userText: '', answerText: '' })])
  eq([r.text, r.included.length], ['', 0])
})
t('缺 turnIndex / score 不崩', () => {
  const r = assembleRecall([{ turnId: 'x', sessionId: 's', userText: 'q', answerText: 'a' }])
  ok(r.text.includes('轮 ?'), '占位')
  ok(r.text.includes('相关度 -'), '占位')
})

console.log('\n【消息构造（异步）】')

console.log('\n【插入位置：必须在当前用户消息之前】')
const currentUser = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '当前提问' }] }
const pluginMsg = { id: 'p1', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '注入' }] }
const history = [{ id: 'h1', role: 'assistant', source: { kind: 'plugin' }, content: [] }]

t('插在最后一条真实用户消息之前', () => {
  const r = insertBeforeCurrentUser([...history, pluginMsg, currentUser], { id: 'r1' })
  ok(r.inserted, '应插入')
  eq(r.messages.map((m) => m.id), ['h1', 'p1', 'r1', 'u1'])
  eq(r.index, 2)
})
t('没有真实用户消息 → 不插入', () => {
  const r = insertBeforeCurrentUser([...history, pluginMsg], { id: 'r1' })
  notOk(r.inserted, '不该插入')
  eq(r.messages.length, 2)
})
t('不改原数组（返回新数组）', () => {
  const original = [...history, currentUser]
  const r = insertBeforeCurrentUser(original, { id: 'r1' })
  eq(original.length, 2)
  eq(r.messages.length, 3)
})
t('空消息数组 / 空消息 → 安全返回', () => {
  eq(insertBeforeCurrentUser([], { id: 'r1' }).inserted, false)
  eq(insertBeforeCurrentUser([currentUser], null).inserted, false)
})

// 异步用例单独跑
const asyncTests = [
  ['无内容 → buildRecallMessage 返回 null（不注入）', async () => eq(await buildRecallMessage([]), null)],
  ['有内容 → plugin 消息结构正确（v4 producer-owned 形态）', async () => {
    const m = await buildRecallMessage(three)
    ok(m, '应有消息')
    eq(m.role, 'user')
    // 2026-10-07 更正：注入 source 恒按 v4 = `plugin:<包名>`（见 lib/source-kind.js）。
    // 旧断言写的是 v3 的 kind='plugin' + 独立 plugin 字段，已随 v4 契约过期。
    eq(m.source.kind, 'plugin:dsh-memory-semantic')
    eq(m.source.form, 'notice')
    ok(m.content[0].type === 'text' && m.content[0].text.includes('记忆召回'), '正文')
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
