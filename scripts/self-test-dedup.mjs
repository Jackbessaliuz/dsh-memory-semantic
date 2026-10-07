/**
 * 去重接线自测：验证 action-trigger 与 recall-shadow 真的用了 injection-ledger
 * 跑法：node scripts/self-test-dedup.mjs
 * 策略：用"假 ledger"记录调用（证明接线生效），再用真 ledger 验证过滤逻辑。
 */
import { createLedger } from '../lib/injection-ledger.js'
import { registerActionTriggers } from '../lib/action-trigger.js'
import { registerRecallShadow } from '../lib/turns/recall-shadow.js'

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass += 1 } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}
import assert from 'node:assert'

const ID_A = '0mtq5t58k-e824466d0be0461a92ec73be94'
const ID_B = '0muwi03hu-b4cba4801d82451cb76b078364'

function fakeCtx() {
  const events = []
  return {
    events,
    logger: { info() {}, warn() {} },
    on: (name, fn) => { events.push({ name, fn }); return () => {} },
    effect: (fn) => { const off = fn(); return () => { try { typeof off === 'function' && off() } catch {} } },
    tools: { register: () => () => {} },
  }
}

/* ── ① action-trigger：登记表被调用（filter 在注入前、remember 在注入后）── */
await t('action-trigger 接线：注入前 filter、注入后 remember', async () => {
  const calls = []
  const fakeLedger = {
    filter: (sid, ids) => { calls.push(['filter', sid, ids.length]); return ids }, // 全通过
    remember: (sid, ids) => { calls.push(['remember', sid, ids.length]); return ids.length },
    observeText: () => 0,
  }
  const ctx = fakeCtx()
  registerActionTriggers(ctx, {
    logger: ctx.logger,
    config: {},
    readMemories: () => [
      { id: ID_A, level: 'rules', project: 'dsh', status: 'active', content: '改插件的红线 安装 bundles 验证 回滚', keywords: '插件 bundles 红线' },
      { id: ID_B, level: 'lesson', project: 'dsh', status: 'active', content: '改插件的教训 双挂载 事故', keywords: '插件 双挂载 事故' },
    ],
    buildBM25: (docs) => (q) => docs.map((d, i) => ({ id: d.id, score: 1 - i * 0.01 })),
    dbPathOf: () => process.execPath, // 只要 existsSync 为真即可
    ledger: fakeLedger,
  })
  const handler = ctx.events.find((e) => e.name === 'tools/post-execute').fn
  const exec = {
    name: 'pwsh',
    arguments: { command: 'node bin/install.js web' },
    agent: { session: { header: { cwd: 'G:/tmp-ws', id: 'session-dedup-1' } } },
  }
  const decision = await handler(exec, {}, async () => ({ kind: 'accept' }))
  assert.ok(Array.isArray(decision.additionalContexts) && decision.additionalContexts.length === 1, '应注入一条')
  const kinds = calls.map((c) => c[0])
  assert.ok(kinds.includes('filter'), '注入前必须调用 filter 去重')
  assert.ok(kinds.includes('remember'), '注入后必须 remember 登记')
  assert.equal(calls[0][1], 'session-dedup-1', '登记键应是会话 id')
})

/* ── ② action-trigger：过滤掉的条目不再出现在注入正文里 ── */
await t('action-trigger 去重：登记过的条目不出现在正文', async () => {
  const ledger = createLedger()
  ledger.remember('session-dedup-2', [ID_A])
  const ctx = fakeCtx()
  registerActionTriggers(ctx, {
    logger: ctx.logger,
    config: {},
    readMemories: () => [
      { id: ID_A, level: 'rules', project: 'dsh', status: 'active', content: '甲条：改插件红线 安装 bundles 验证', keywords: '插件 bundles' },
      { id: ID_B, level: 'lesson', project: 'dsh', status: 'active', content: '乙条：改插件教训 双挂载 事故', keywords: '插件 双挂载' },
    ],
    buildBM25: (docs) => (q) => docs.map((d, i) => ({ id: d.id, score: 1 - i * 0.01 })),
    dbPathOf: () => process.execPath,
    ledger,
  })
  const handler = ctx.events.find((e) => e.name === 'tools/post-execute').fn
  const exec = {
    name: 'pwsh',
    arguments: { command: 'node bin/install.js web' },
    agent: { session: { header: { cwd: 'G:/tmp-ws', id: 'session-dedup-2' } } },
  }
  const decision = await handler(exec, {}, async () => ({ kind: 'accept' }))
  const text = decision.additionalContexts?.[0]?.content?.[0]?.text || ''
  assert.ok(text.includes('乙条'), '未登记的条目应该注入')
  assert.ok(!text.includes('甲条'), '已登记的条目不该再注入')
})

/* ── ③ recall-shadow：pre-step 会把上下文里已有的记忆 id 登记进表 ── */
await t('recall-shadow 接线：pre-step 登记上下文里的记忆 id', async () => {
  const observed = []
  const fakeLedger = {
    observeText: (sid, text) => { observed.push({ sid, text }); return 1 },
    filter: (sid, ids) => ids,
    remember: () => 0,
  }
  const ctx = fakeCtx()
  ctx.on = (name, fn) => { ctx.events.push({ name, fn }); return () => {} }
  registerRecallShadow(ctx, {
    logger: ctx.logger,
    config: { turns: { recallShadow: { inject: false } } },
    ledger: fakeLedger,
  })
  const pre = ctx.events.find((e) => e.name === 'agent/pre-step')
  assert.ok(pre, '应注册 agent/pre-step')
  const messages = [
    { role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: `【长期记忆】[fact] [${ID_A}] 内容` }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  ]
  await pre.fn({ agent: { session: { header: { cwd: 'G:/tmp-ws', id: 'session-dedup-3' } } }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
  assert.ok(observed.length >= 1, 'observeText 应被调用')
  assert.ok(observed.some((o) => String(o.text).includes(ID_A)), '应把 meow-memory 注入里的 id 带上')
  assert.equal(observed[0].sid, 'session-dedup-3', '应使用会话 id')
})

console.log(`\n去重接线自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
