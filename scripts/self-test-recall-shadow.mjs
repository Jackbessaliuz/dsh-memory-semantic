/**
 * 自测：上下文组装接线（lib/turns/recall-shadow.js）
 * 跑法：node scripts/self-test-recall-shadow.mjs
 *
 * 全程离线：真 sqlite（临时目录）+ 假 agent/消息 + 关掉向量（不碰 Ollama）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeShadowConfig, extractQuery, visibleKeysOf, planRecall,
  appendShadow, shadowPathOf, createShadowRuntime, registerRecallShadow,
} from '../lib/turns/recall-shadow.js'
import { openTurnsDb } from '../lib/turns/schema.js'
import { upsertTurn, replaceTriples, statsOf } from '../lib/turns/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(here, '..', '_tmp', 'self-test-recall-shadow')

let pass = 0
let fail = 0
const failures = []
function t(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    fail += 1; failures.push(name + ' → 异步用例必须放进 asyncTests')
    console.log('  ✗', name, '→ 异步用例不能进 t()')
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

/* ── 夹具 ─────────────────────────────────────────────────────────── */

function freshWorkspace(name) {
  const dir = path.join(TMP, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 往库里写一轮（真 upsert + 真 SPO）。 */
function seedTurn(db, { sessionId, turnIndex, userSeq, answerSeq, userText, answerText, outcome = 'completed', triples = [] }) {
  const record = upsertTurn(db, { sessionId, turnIndex, summary: `${userText} → ${answerText}`, outcome, userSeq, answerSeq, userText, answerText })
  if (triples.length) replaceTriples(db, record.id, sessionId, triples)
  return record
}

const userMessage = (text, id = 'm1') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const pluginMessage = (text, id = 'm2') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'meow-memory', form: 'snapshot' } })
const fakeAgent = (id, cwd, origin) => ({ session: { header: { id, cwd, ...(origin ? { origin } : {}) } } })
const decisionOf = (messages) => ({ kind: 'enter', messages })
const offlineCfg = (patch = {}) => ({ ...normalizeShadowConfig(undefined), vector: false, ...patch })

async function settle(ms = 120) { await new Promise((resolve) => setTimeout(resolve, ms)) }
function readShadowLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

/* ── 同步用例 ─────────────────────────────────────────────────────── */

console.log('\n【配置】')
t('默认：只记录不注入（inject=false），k=5，可见轮 6', () => {
  const cfg = normalizeShadowConfig(undefined)
  ok(cfg, '默认应开启')
  eq([cfg.inject, cfg.k, cfg.visibleTurns, cfg.vector, cfg.mainSessionsOnly], [false, 5, 6, true, true])
})
t('enabled=false → 整块关（返回 null）', () => {
  eq(normalizeShadowConfig({ turns: { recallShadow: { enabled: false } } }), null)
})
t('inject 必须显式 true 才打开', () => {
  eq(normalizeShadowConfig({ turns: { recallShadow: {} } }).inject, false)
  eq(normalizeShadowConfig({ turns: { recallShadow: { inject: true } } }).inject, true)
  eq(normalizeShadowConfig({ turns: { recallShadow: { inject: 'yes' } } }).inject, false, '字符串不算')
})
t('数值越界被夹住', () => {
  const cfg = normalizeShadowConfig({ turns: { recallShadow: { k: 99, visibleTurns: -3, maxTurns: 99, maxChars: 1 } } })
  eq([cfg.k, cfg.visibleTurns, cfg.maxTurns, cfg.maxChars], [20, 0, 12, 400])
})

console.log('\n【extractQuery：本轮问什么】')
t('取最后一条真实用户消息', () => {
  eq(extractQuery([userMessage('第一问'), userMessage('第二问')]), '第二问')
})
t('plugin 注入消息不算（跳过找更早的真实消息）', () => {
  eq(extractQuery([userMessage('真问题'), pluginMessage('===== 长期记忆 =====\n注入')]), '真问题')
})
t('用户消息里带注入块 → 剥掉只留提问', () => {
  const messages = [{ id: 'x', role: 'user', content: [{ type: 'text', text: '【记忆自动注入】一堆东西' }, { type: 'text', text: '我要问的是这个' }], source: { kind: 'user' } }]
  eq(extractQuery(messages), '我要问的是这个')
})
t('没有真实用户消息 → null', () => {
  eq(extractQuery([pluginMessage('注入')]), null)
  eq(extractQuery([]), null)
  eq(extractQuery(undefined), null)
})

console.log('\n【visibleKeysOf：最近 N 轮不重复召回】')
t('取本会话最近 N 轮的 key，且按会话隔离', () => {
  const ws = freshWorkspace('visible-keys')
  const db = openTurnsDb(ws)
  for (let i = 0; i < 4; i += 1) {
    seedTurn(db, { sessionId: 'session-a', turnIndex: i, userSeq: i * 2, answerSeq: i * 2 + 1, userText: `问题${i}`, answerText: `答案${i}` })
  }
  seedTurn(db, { sessionId: 'session-b', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '别的会话', answerText: '答' })
  eq([...visibleKeysOf(db, 'session-a', 2)].sort(), ['session-a:4', 'session-a:6'])
  eq([...visibleKeysOf(db, 'session-a', 0)].length, 0, 'visibleTurns=0 时排除集为空')
  db.close()
})

/* ── 异步用例 ─────────────────────────────────────────────────────── */

const asyncTests = [
  ['planRecall：命中 + 排除最近可见轮次', async () => {
    const ws = freshWorkspace('plan-recall')
    const db = openTurnsDb(ws)
    seedTurn(db, { sessionId: 'session-x', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '讨论上下文接管的折叠窗口', answerText: '把更早的历史折叠成常量归档标记，召回命中时再把原始问答插回当前提问之前。' })
    seedTurn(db, { sessionId: 'session-x', turnIndex: 1, userSeq: 2, answerSeq: 3, userText: '别的杂事', answerText: '嗯' })
    seedTurn(db, { sessionId: 'session-x', turnIndex: 2, userSeq: 4, answerSeq: 5, userText: '今天天气', answerText: '晴' })
    const plan = await planRecall({ db, sessionId: 'session-x', query: '上下文接管折叠窗口怎么取', cfg: offlineCfg({ k: 5, visibleTurns: 2 }) })
    ok(plan.results.length >= 1, '应命中至少一轮')
    eq(plan.results[0].turnIndex, 0, '命中的是最早那轮（最近 2 轮被排除）')
    ok(plan.diagnostics.candidates === 1, `候选应只剩 1（实际 ${plan.diagnostics.candidates}）`)
    ok(plan.message, '组装出可注入消息')
    ok(plan.assembled.text.includes('【记忆召回'), '正文带标识')
    ok(plan.assembled.text.includes('折叠窗口'), '正文含原始 Q/A 证据')
    db.close()
  }],

  ['planRecall：无命中 → 不组装（宁可没有也不灌水）', async () => {
    const ws = freshWorkspace('plan-empty')
    const db = openTurnsDb(ws)
    seedTurn(db, { sessionId: 'session-x', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '完全无关的话题', answerText: '嗯' })
    const plan = await planRecall({ db, sessionId: 'session-x', query: 'zzzzz 不存在的词', cfg: offlineCfg({ visibleTurns: 0 }) })
    eq(plan.assembled.text, '')
    eq(plan.message, null)
    db.close()
  }],

  ['appendShadow：JSONL 追加、字段齐全、不覆盖旧行', async () => {
    const ws = freshWorkspace('shadow-file')
    eq(appendShadow(ws, { at: 1, sessionId: 'a' }), true)
    eq(appendShadow(ws, { at: 2, sessionId: 'b' }), true)
    const lines = readShadowLines(shadowPathOf(ws))
    eq(lines.length, 2)
    eq(lines.map((x) => x.sessionId), ['a', 'b'])
  }],

  ['旁路模式：原样返回 decision，一个字节都不改', async () => {
    const ws = freshWorkspace('shadow-passthrough')
    const db = openTurnsDb(ws)
    seedTurn(db, { sessionId: 'session-p', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '关于折叠窗口的讨论', answerText: '把更早的历史折叠成常量归档标记，召回命中时再把原始问答插回当前提问之前。' })
    db.close()
    const runtime = createShadowRuntime({ cfg: offlineCfg({ visibleTurns: 0 }), logger: null })
    const messages = [userMessage('再讲讲折叠窗口')]
    const decision = decisionOf(messages)
    const out = await runtime.onPreStep({ agent: fakeAgent('session-p', ws), turn: 1, step: 1 }, async () => decision)
    eq(out, decision, '返回的就该是 next() 那个 decision')
    eq(out.messages, messages, 'messages 数组引用不变')
    await settle()
    const lines = readShadowLines(shadowPathOf(ws))
    eq(lines.length, 1, '应写了一行')
    eq([lines[0].wouldInject, lines[0].injected], [true, false], '记录了"如果注入"但没真注入')
    ok(lines[0].hits.length >= 1, '命中列表非空')
    ok(typeof lines[0].queryHead === 'string' && lines[0].queryHead.length > 0, '记录查询头')
    runtime.dispose()
  }],

  ['同轮多 step 去重：同一问句只记录一次', async () => {
    const ws = freshWorkspace('shadow-dedupe')
    const db = openTurnsDb(ws)
    seedTurn(db, { sessionId: 'session-d', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '折叠窗口', answerText: '把更早的历史折叠成常量归档标记，召回命中时再把原始问答插回当前提问之前。' })
    db.close()
    const runtime = createShadowRuntime({ cfg: offlineCfg({ visibleTurns: 0 }), logger: null })
    const agent = fakeAgent('session-d', ws)
    const messages = [userMessage('讲讲折叠窗口')]
    await runtime.onPreStep({ agent, turn: 1, step: 1 }, async () => decisionOf(messages))
    await runtime.onPreStep({ agent, turn: 1, step: 2 }, async () => decisionOf(messages))
    await runtime.onPreStep({ agent, turn: 1, step: 3 }, async () => decisionOf(messages))
    await settle()
    eq(readShadowLines(shadowPathOf(ws)).length, 1, '同轮只记一次')
    // 换一个问句 → 应再记一行
    await runtime.onPreStep({ agent, turn: 2, step: 1 }, async () => decisionOf([userMessage('换个话题问折叠窗口')]))
    await settle()
    eq(readShadowLines(shadowPathOf(ws)).length, 2)
    runtime.dispose()
  }],

  ['inject=true：真的插到"最后一条真实用户消息"之前', async () => {
    const ws = freshWorkspace('shadow-inject')
    const db = openTurnsDb(ws)
    seedTurn(db, { sessionId: 'session-i', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '关于折叠窗口的讨论', answerText: '把更早的历史折叠成常量归档标记，召回命中时再把原始问答插回当前提问之前。' })
    db.close()
    const runtime = createShadowRuntime({ cfg: offlineCfg({ visibleTurns: 0, inject: true }), logger: null })
    const messages = [pluginMessage('【接力上下文】上个会话尾巴'), userMessage('折叠窗口再讲讲')]
    const out = await runtime.onPreStep({ agent: fakeAgent('session-i', ws), turn: 1, step: 1 }, async () => decisionOf(messages))
    eq(out.messages.length, 3, '多出一条召回消息')
    eq(out.messages[1].source.kind, 'plugin:dsh-memory-semantic', '注入物是 plugin 消息（v4 producer-owned 形态）')
    eq(String(out.messages[1].source.summary).includes('记忆召回'), true)
    eq(out.messages[2].source.kind, 'user', '真实用户消息仍在最后')
    eq(out.messages[2].content[0].text, '折叠窗口再讲讲', '原消息内容没被动过')
    const lines = readShadowLines(shadowPathOf(ws))
    eq(lines[lines.length - 1].injected, true, '记录里标了真注入')
    runtime.dispose()
  }],

  ['闸门：非主会话 / 子代理 / 非 enter 决策都不记录', async () => {
    const ws = freshWorkspace('shadow-gates')
    const db = openTurnsDb(ws)
    seedTurn(db, { sessionId: 'session-g', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '折叠窗口', answerText: '把更早的历史折叠成常量归档标记，召回命中时再把原始问答插回当前提问之前。' })
    db.close()
    const runtime = createShadowRuntime({ cfg: offlineCfg({ visibleTurns: 0 }), logger: null })
    const messages = [userMessage('折叠窗口')]
    await runtime.onPreStep({ agent: fakeAgent('abc-uuid', ws), turn: 1, step: 1 }, async () => decisionOf(messages))
    await runtime.onPreStep({ agent: fakeAgent('session-sub', ws, 'subagent'), turn: 1, step: 1 }, async () => decisionOf(messages))
    await runtime.onPreStep({ agent: fakeAgent('session-g', ws), turn: 1, step: 1 }, async () => ({ kind: 'reject' }))
    await settle()
    eq(readShadowLines(shadowPathOf(ws)).length, 0, '三种都不该记录')
    runtime.dispose()
  }],

  ['fail-open：next() 抛错 / 空决策 / 库不存在都不崩', async () => {
    const ws = freshWorkspace('shadow-failopen')
    const runtime = createShadowRuntime({ cfg: offlineCfg(), logger: null })
    let threw = false
    try {
      await runtime.onPreStep({ agent: fakeAgent('session-f', ws), turn: 1, step: 1 }, async () => { throw new Error('下游炸了') })
    } catch { threw = true }
    ok(threw, 'next() 的错应原样抛出（不由我们吞掉）')
    // 库不存在的 workspace：只观察、不建库
    const decision = decisionOf([userMessage('你好')])
    const out = await runtime.onPreStep({ agent: fakeAgent('session-f2', freshWorkspace('shadow-nodb')), turn: 1, step: 1 }, async () => decision)
    eq(out, decision)
    ok(!fs.existsSync(path.join(path.join(TMP, 'shadow-nodb'), '.dsh-semantic', 'turns.db')), '旁路不该凭空建库')
    await settle()
    runtime.dispose()
  }],

  ['registerRecallShadow：注册进 ctx、可关、可清理', async () => {
    const handlers = {}
    let disposed = 0
    let cleanup = null
    const ctx = {
      on: (name, handler) => { handlers[name] = handler; return () => { disposed += 1 } },
      // 真宿主会在插件卸载时调用 effect 的返回；夹具照样存下来，测试里手动触发
      effect: (fn) => { cleanup = fn(); return cleanup },
      logger: null,
    }
    const runtime = registerRecallShadow(ctx, { logger: null, config: undefined })
    ok(runtime, '默认应注册')
    ok(typeof handlers['agent/pre-step'] === 'function', '应订阅 agent/pre-step')
    eq(registerRecallShadow(ctx, { logger: null, config: { turns: { recallShadow: { enabled: false } } } }), null, '关掉时返回 null')
    ok(typeof cleanup === 'function', 'effect 应返回清理器')
    cleanup()
    eq(disposed, 1, '卸载时应取消订阅')
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
