// guard 折叠路径确定性测试（2026-11-16，GPT 要求的第一步）
// 用 mock session 跑生产同一套 findDegenerate → planSpan → append 逻辑，
// 检查：替换事件长什么样、工具结果是否保留、dryRun 是否不动、配对不完整是否跳过。
import { apply } from '../lib/guard/thinking-guard.mjs'

let pass = 0, fail = 0
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m, extra === undefined ? '' : JSON.stringify(extra).slice(0, 160)) } }

const repeat = Array.from({ length: 30 }, () => '让我来写这个函数，先看看现有实现，然后补上参数校验和错误处理。').join('')
const normal = ('我需要先确认这个改动的影响范围。第一步看 config.js 的默认值，'
  + '第二步检查 searchMemory 的调用点，第三步跑自测。目前看时间衰减和 PPR 是独立的两个环节，'
  + '它们叠加时可能互相放大，所以要把分数分解出来看。').repeat(3)

function makeCtx() {
  const handlers = {}
  const ctx = {
    on: (n, fn) => { handlers[n] = fn },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, handlers }
}

function makeSession(nodes, events) {
  const appended = []
  const map = new Map(events)
  const session = {
    surface: { nodes },
    eventAt: (seq) => map.get(seq),
    deriveEventMessage: (ev) => ev.message,
    append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: 900 + appended.length } },
    header: {},
  }
  return { session, appended }
}

async function run(modeCfg, nodes, events) {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { enabled: true, ...modeCfg })
  const { session, appended } = makeSession(nodes, events)
  await handlers['agent/pre-step']({ agent: { session } }, async () => {})
  return appended
}

const degenerateMsg = {
  content: [
    { type: 'reasoning', text: repeat },
    { type: 'tool-call', id: 'c1', name: 'read', args: { path: 'a.txt' } },
  ],
}
// 真实结构（2026-11-16 从会话日志确认）：message.content 是 [{type:'text', text}]，isError 在 message 层
const resultEv = {
  type: 'tool/result',
  message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'file content here 关键结果' }] },
}

console.log('== 场景 A：复读 + 工具调用 + 完整配对（真折叠，dryRun=false）==')
{
  const events = [[1, { type: 'assistant/message', surfaceOp: 'append', message: degenerateMsg }], [2, resultEv]]
  const appended = await run({ dryRun: false, rotationGuard: false }, [1, 2], events)
  ok(appended.length === 1, '产生 1 条替换事件', appended.length)
  const a = appended[0] || {}
  ok(a.type === 'system/message', '替换事件类型 = system/message（B 方案）', a.type)
  ok(a.data?.role === 'system', 'role = system（不再是用户消息）', a.data?.role)
  ok(a.data?.source?.kind === 'plugin:thinking-guard', '有 plugin:thinking-guard 来源标记', a.data?.source)
  ok(a.opts?.surfaceOp?.op === 'replace', 'surfaceOp = replace', a.opts?.surfaceOp)
  const span = a.opts?.sourceEventSeqs
  ok(Array.isArray(span) && span.join(',') === '1,2', 'sourceEventSeqs = [1,2]（可追溯来源）', span)
  const note = a.data?.content?.[0]?.text || ''
  ok(note.includes('⟪thinking-guard⟫'), '替换文本带明显系统标记')
  ok(note.includes('read'), '工具调用名保留在摘要里')
  ok(note.includes('关键结果'), '工具结果摘要保留（不重复执行的依据）')
  console.log('    —— 替换文本全文 ——')
  console.log('    ' + note.replace(/\n/g, '\n    ').slice(0, 600))
}

console.log('\n== 场景 B：dryRun=true（演练模式）==')
{
  const events = [[1, { type: 'assistant/message', surfaceOp: 'append', message: degenerateMsg }], [2, resultEv]]
  const appended = await run({ dryRun: true, rotationGuard: false }, [1, 2], events)
  ok(appended.length === 0, '演练模式不产生任何替换事件', appended.length)
}

console.log('\n== 场景 C：正常内容（不重复）==')
{
  const msg = { content: [{ type: 'reasoning', text: normal }] }
  const appended = await run({ dryRun: false, rotationGuard: false }, [1], [[1, { type: 'assistant/message', surfaceOp: 'append', message: msg }]])
  ok(appended.length === 0, '正常内容不折叠', appended.length)
}

console.log('\n== 场景 D：有工具调用但结果还没落进 surface（配对不完整）==')
{
  const appended = await run({ dryRun: false, rotationGuard: false }, [1], [[1, { type: 'assistant/message', surfaceOp: 'append', message: degenerateMsg }]])
  ok(appended.length === 0, '配对不完整时跳过（等结果到位再剪）', appended.length)
}

console.log('\n== 场景 E：否定变化重复（v2 关闭后）==')
{
  const neg = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? '这个方案可行，可以继续。' : '这个方案不可行，需要回退。')).join('')
  const msg = { content: [{ type: 'reasoning', text: neg }] }
  const appended = await run({ dryRun: false, rotationGuard: false }, [1], [[1, { type: 'assistant/message', surfaceOp: 'append', message: msg }]])
  ok(appended.length === 0, '否定变化重复不被折叠', appended.length)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
