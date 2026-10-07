/**
 * dsh-memory-semantic · 动作触发注入 自测（node scripts/self-test-action-trigger.mjs）
 * 覆盖：规则归一化 / 动作匹配 / 真实记忆库检索 / 注入文本体积 / 端到端（含冷却与降级）。
 * 只读，不改任何数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { normalizeRules, matchRule, selectMemories, buildInjectionText, registerActionTriggers } from '../lib/action-trigger.js'
import { readMemories, buildBM25 } from '../lib/index.js'

const workspace = process.env.SELF_TEST_WORKSPACE || process.cwd()
const dbFile = path.join(workspace, '.dsh-meow', 'memory.db')
let passed = 0
function ok(label, cond, extra) {
  assert.ok(cond, label + (extra ? ' — ' + extra : ''))
  passed++
  console.log('  ✓ ' + label + (extra ? '  ' + extra : ''))
}

console.log('# 1. 规则归一化')
const rules = normalizeRules({})
ok('默认内置 1 条规则', rules.length === 1, rules[0] && rules[0].id)
ok('enabled:false 时清空', normalizeRules({ actionTriggers: { enabled: false } }).length === 0)
ok('自定义规则可覆盖', normalizeRules({ actionTriggers: { rules: [{ id: 'x', query: 'q', tools: 'write,edit' }] } })[0].tools.length === 2)
ok('非法正则降级为 null 而不抛错', normalizeRules({ actionTriggers: { rules: [{ id: 'x', query: 'q', match: '([' }] } })[0].match === null)

console.log('# 2. 动作匹配')
const rule = rules[0]
ok('pwsh 跑 install.js → 命中', matchRule(rules, { name: 'pwsh', arguments: { command: 'node bin/install.js web' } }) !== null)
ok('write 改 cordis.patch.yml → 命中', matchRule(rules, { name: 'write', arguments: { file_path: 'C:/x/cordis.patch.yml' } }) !== null)
ok('edit 改 preset.yml → 命中', matchRule(rules, { name: 'edit', arguments: { file_path: 'a/preset.yml' } }) !== null)
ok('无关命令 Get-Date → 不命中', matchRule(rules, { name: 'pwsh', arguments: { command: 'Get-Date' } }) === null)
ok('read 读 package.json → 不命中（工具不在表内）', matchRule(rules, { name: 'read', arguments: { file_path: 'package.json' } }) === null)

console.log('# 3. 真实记忆库检索')
if (!fs.existsSync(dbFile)) {
  console.log('  ! 跳过：记忆库不存在 ' + dbFile)
} else {
  const rows = readMemories(dbFile)
  ok('读到记忆行', rows.length > 0, rows.length + ' 行')
  const hits = selectMemories(rows, buildBM25, rule)
  ok('命中 dsh 红线/教训', hits.length > 0, hits.length + ' 条')
  ok('全部属于 dsh 且 level 受限', hits.every((h) => String(h.project || '').includes('dsh') && ['rules', 'lesson'].includes(h.level)))
  console.log('    命中示例：' + hits.slice(0, 3).map((h) => `[${h.level}] ${String(h.content).slice(0, 40)}…`).join(' | '))
  const text = buildInjectionText(rule, hits, { name: 'pwsh' })
  ok('注入文本含标题与动作名', text.includes('记忆自动注入') && text.includes('pwsh'))
  ok('注入文本受 maxChars 约束', text.length <= rule.maxChars + 200, text.length + ' 字符')
}

console.log('# 4. 端到端（假 ctx，含冷却）')
const events = []
const logs = []
const fakeCtx = { on: (name, fn) => { events.push({ name, fn }) }, logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) } }
registerActionTriggers(fakeCtx, { logger: fakeCtx.logger, config: {}, readMemories, buildBM25, dbPathOf: (ws) => path.join(ws, '.dsh-meow', 'memory.db') })
ok('注册了 tools/post-execute 监听', events.length === 1 && events[0].name === 'tools/post-execute')
ok('启动日志声明规则', logs.some((l) => l.includes('action triggers on')))

const handler = events[0].fn
const exec = { name: 'pwsh', arguments: { command: 'node bin/install.js web' }, agent: { session: { header: { cwd: workspace } } } }
const first = await handler(exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
if (fs.existsSync(dbFile)) {
  ok('首次调用注入 1 条 context', Array.isArray(first.additionalContexts) && first.additionalContexts.length === 1)
  const msg = first.additionalContexts[0]
  ok('消息结构合法（role/source/content，v4 producer-owned 形态）', msg.role === 'user' && msg.source.kind === 'plugin:dsh-memory-semantic' && msg.source.form === 'notice' && Array.isArray(msg.content))
  ok('消息带 id', typeof msg.id === 'string' && msg.id.length > 0)
  console.log('    注入摘要：' + msg.source.summary)
  const second = await handler(exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
  ok('冷却期内不重复注入', !second.additionalContexts || second.additionalContexts.length === 0)
  const other = await handler({ name: 'pwsh', arguments: { command: 'Get-Date' }, agent: exec.agent }, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
  ok('不匹配的动作不注入', !other.additionalContexts)
}
const passthrough = await handler({ name: 'pwsh', arguments: { command: 'node bin/install.js' } }, {}, async () => ({ kind: 'accept' }))
ok('无工作区时静默放行（不抛错）', passthrough.kind === 'accept')

console.log(`\n✅ 全部通过：${passed} 项断言`)
