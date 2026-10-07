/**
 * 自测：宿主轮次投影（lib/turns/project.js）+ 会话日志读取（lib/turns/session-log.js）
 * 跑法：node scripts/self-test-project.mjs
 * 单元部分用构造事件；真机部分只读 ~/.dsh/sessions 下的真实日志（不写任何东西）。
 */
import {
  INJECTION_MARKERS, isInjectionBlock, splitInjected, textOfBlocks,
  isRealUserTurn, hasVisibleAnswer, collectTurnEndpoints, projectTurn, projectCompletedTurns,
} from '../lib/turns/project.js'
import { readSessionEvents, findSessionLog, frameOffsets } from '../lib/turns/session-log.js'

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
function throws(fn, label = '') {
  let threw = false
  try { fn() } catch { threw = true }
  if (!threw) throw new Error(`${label} 应该抛错但没有`)
}

/* ── 构造事件 ─────────────────────────────────────────────────────── */
const userEvent = (seq, text, options = {}) => ({
  seq,
  type: 'user/message',
  data: {
    id: 'u' + seq,
    role: 'user',
    source: { kind: options.kind ?? 'user' },
    content: [...(options.injected ?? []), ...(options.blocks ?? [{ type: 'text', text }])],
  },
})
const assistantEvent = (seq, text, options = {}) => ({
  seq,
  type: 'assistant/message',
  data: {
    message: {
      id: 'a' + seq,
      role: 'assistant',
      content: [...(options.before ?? []), { type: 'text', text }, ...(options.after ?? [])],
    },
  },
})
const reasoningOnly = (seq, text) => ({
  seq,
  type: 'assistant/message',
  data: { message: { id: 'a' + seq, role: 'assistant', content: [{ type: 'reasoning', text }] } },
})
const toolCall = (seq) => ({ seq, type: 'tool/call', data: { name: 'pwsh' } })
const injection = (text) => ({ type: 'text', text })
const LONG_MEMORY = injection('===== 长期记忆 =====\n【关于你】- 记忆的意义…')
const HIT_MEMORY = injection('可能相关的记忆，仅供参考：\n[dsh : lesson] …')
const ACTION_INJECT = injection('【记忆自动注入 · dsh-memory-semantic】\n检测到动作…')
const RELAY_INJECT = injection('【接力上下文 · dsh-memory-semantic】\n你在新会话里提到了"继续"…')

console.log('\n【注入块识别】')
t('5 个标记常量在册', () => ok(INJECTION_MARKERS.length === 5, '标记数'))
t('长期记忆块 → 注入', () => ok(isInjectionBlock(LONG_MEMORY)))
t('关键词命中块 → 注入', () => ok(isInjectionBlock(HIT_MEMORY)))
t('动作触发块 → 注入', () => ok(isInjectionBlock(ACTION_INJECT)))
t('接力上下文块 → 注入', () => ok(isInjectionBlock(RELAY_INJECT)))
t('普通用户文本 → 不是注入', () => ok(!isInjectionBlock({ type: 'text', text: '助手我们来聊聊记忆沙龙' })))
t('非文本块 → 不是注入', () => ok(!isInjectionBlock({ type: 'image', attachment: {} })))
t('前面有空白仍能识别', () => ok(isInjectionBlock(injection('   \n===== 长期记忆 =====\n…'))))

console.log('\n【拆分注入与真话】')
t('注入在前 → 剥掉，真话保留', () => {
  const { injected, real } = splitInjected([LONG_MEMORY, injection('把目前状态备份')])
  eq(injected.length, 1)
  eq(textOfBlocks(real), '把目前状态备份')
})
t('多个注入块连续在头部 → 全部剥掉', () => {
  const { injected, real } = splitInjected([LONG_MEMORY, HIT_MEMORY, injection('继续')])
  eq(injected.length, 2)
  eq(textOfBlocks(real), '继续')
})
t('注入夹在真话之后 → 不剥（只剥开头连续段）', () => {
  const { injected, real } = splitInjected([injection('先说一句'), LONG_MEMORY])
  eq(injected.length, 0)
  eq(real.length, 2)
})
t('无注入 → injected 空', () => eq(splitInjected([injection('你好')]).injected.length, 0))
t('内容不是数组 → 安全返回空', () => {
  eq(splitInjected(null).real.length, 0)
  eq(splitInjected(undefined).injected.length, 0)
})

console.log('\n【文本投影规则】')
t('只取 text，不带上 reasoning', () => {
  eq(textOfBlocks([{ type: 'reasoning', text: '嗯嗯嗯' }, { type: 'text', text: '结论是 A' }]), '结论是 A')
})
t('includeReasoning=true 才带 reasoning', () => {
  ok(textOfBlocks([{ type: 'reasoning', text: '嗯' }, { type: 'text', text: 'A' }], { includeReasoning: true }).includes('嗯'))
})
t('图片等非文本块 → 占位符', () => {
  eq(textOfBlocks([{ type: 'image', attachment: {} }, { type: 'text', text: '看图' }]), '⟨image⟩\n看图')
})
t('placeholders=false → 不占位', () => {
  eq(textOfBlocks([{ type: 'image', attachment: {} }, { type: 'text', text: '看图' }], { placeholders: false }), '看图')
})
t('空文本块被忽略', () => eq(textOfBlocks([{ type: 'text', text: '   ' }]), ''))

console.log('\n【轮次端点扫描】')
t('真实用户轮判定', () => {
  ok(isRealUserTurn(userEvent(0, 'hi')))
  ok(!isRealUserTurn(userEvent(0, 'hi', { kind: 'plugin' })))
  ok(!isRealUserTurn(assistantEvent(1, 'ho')))
})
t('可见回答判定（只有 reasoning 不算作答）', () => {
  ok(hasVisibleAnswer(assistantEvent(1, '答案')))
  ok(!hasVisibleAnswer(reasoningOnly(1, '想了很久')))
  ok(!hasVisibleAnswer(toolCall(1)))
})
t('两轮完整 → turnIndex 0/1', () => {
  const events = [userEvent(0, 'Q1'), assistantEvent(1, 'A1'), userEvent(2, 'Q2'), assistantEvent(3, 'A2')]
  eq(collectTurnEndpoints(events).map((x) => [x.turnIndex, x.userSeq, x.answerSeq, x.complete]), [[0, 0, 1, true], [1, 2, 3, true]])
})
t('末轮未答 → complete=false', () => {
  const events = [userEvent(0, 'Q1'), assistantEvent(1, 'A1'), userEvent(2, 'Q2')]
  eq(collectTurnEndpoints(events).map((x) => x.complete), [true, false])
})
t('一轮里多个工具/中间步骤 → 只取最后一个可见回答', () => {
  const events = [userEvent(0, 'Q1'), toolCall(1), assistantEvent(2, '中间话'), toolCall(3), assistantEvent(4, '最终答案')]
  eq(collectTurnEndpoints(events)[0].answerSeq, 4)
})
t('plugin 注入的 user/message 不新开轮', () => {
  const events = [userEvent(0, 'Q1'), userEvent(1, '', { kind: 'plugin', injected: [RELAY_INJECT] }), assistantEvent(2, 'A1')]
  const turns = collectTurnEndpoints(events)
  eq(turns.length, 1)
  eq(turns[0].userSeq, 0)
})
t('reasoning-only 的 assistant 不算作答，后面真正的回答才算', () => {
  const events = [userEvent(0, 'Q1'), reasoningOnly(1, '思考'), assistantEvent(2, '真答案')]
  eq(collectTurnEndpoints(events)[0].answerSeq, 2)
})
t('sinceSeq 只取新轮', () => {
  const events = [userEvent(0, 'Q1'), assistantEvent(1, 'A1'), userEvent(2, 'Q2'), assistantEvent(3, 'A2')]
  eq(collectTurnEndpoints(events, { sinceSeq: 1 }).map((x) => x.userSeq), [2])
})

console.log('\n【投影一轮】')
t('正常一轮：Q/A 都干净', () => {
  const events = [userEvent(0, '把目前状态备份', { injected: [LONG_MEMORY] }), assistantEvent(1, '备份完成，3.85GB。')]
  const p = projectTurn(events, 0, 1, { sessionId: 's1', turnIndex: 0 })
  eq(p.userText, '把目前状态备份')
  eq(p.answerText, '备份完成，3.85GB。')
  eq(p.injectedBlocks, 1)
  ok(p.injectedChars > 10, '注入字符数')
})
t('回答里的 reasoning 不进投影', () => {
  const events = [userEvent(0, 'Q'), assistantEvent(1, '答案', { before: [{ type: 'reasoning', text: '秘密推理过程' }] })]
  const p = projectTurn(events, 0, 1)
  ok(!p.answerText.includes('秘密推理过程'), '不应含 reasoning')
  eq(p.answerText, '答案')
})
t('用户全是注入 → 返回 null', () => {
  const events = [userEvent(0, '', { injected: [LONG_MEMORY] }), assistantEvent(1, 'A')]
  eq(projectTurn(events, 0, 1), null)
})
t('回答只有工具调用 → 返回 null', () => {
  const events = [userEvent(0, 'Q'), { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh', arguments: '{}' }] } } }]
  eq(projectTurn(events, 0, 1), null)
})
t('userSeq 指向非用户事件 → 抛错', () => {
  const events = [assistantEvent(0, 'A')]
  throws(() => projectTurn(events, 0, 0), 'userSeq')
})
t('answerSeq 指向非助手事件 → 抛错', () => {
  const events = [userEvent(0, 'Q'), toolCall(1)]
  throws(() => projectTurn(events, 0, 1), 'answerSeq')
})
t('projectCompletedTurns 跳过未完成轮', () => {
  const events = [userEvent(0, 'Q1', { injected: [HIT_MEMORY] }), assistantEvent(1, 'A1'), userEvent(2, 'Q2')]
  const all = projectCompletedTurns(events, { sessionId: 's1' })
  eq(all.length, 1)
  eq(all[0].userText, 'Q1')
})

const TARGET = process.env.TURNS_TEST_SESSION || ''
console.log(TARGET
  ? '\n【真机：真实会话日志】'
  : '\n【真机：真实会话日志】跳过（本段需要本机真实会话：设 TURNS_TEST_SESSION=<session-id> 才会跑）')
let realOk = false
if (TARGET) t('找到会话日志', () => {
  const file = findSessionLog(TARGET)
  ok(file, '日志路径')
  globalThis.__log = file
})
if (globalThis.__log) {
  const file = globalThis.__log
  const log = readSessionEvents(file)
  t('多帧解压与 header 分离', () => {
    ok(log.frames > 1, '帧数 > 1')
    ok(log.header?.id, 'header 有 id')
    eq(log.unparsed, 0, '未解析行')
  })
  t('事件 seq 从 0 连续（可直接喂 foldSurface）', () => ok(log.seqContiguous, 'seq 连续'))
  t('真机投影出已完成轮', () => {
    const turns = projectCompletedTurns(log.events, { sessionId: log.header.id })
    ok(turns.length > 0, '轮数')
    globalThis.__turns = turns
  })
  if (globalThis.__turns) {
    const turns = globalThis.__turns
    t('每轮 userText 与 answerText 都非空', () => {
      for (const turn of turns) {
        ok(turn.userText.length > 0, `轮 ${turn.turnIndex} Q`)
        ok(turn.answerText.length > 0, `轮 ${turn.turnIndex} A`)
      }
    })
    t('真机：注入以独立 plugin 事件存在（靠 source.kind 即排除）', () => {
      const pluginUsers = log.events.filter((e) => e.type === 'user/message' && e.data?.source?.kind !== 'user')
      ok(pluginUsers.length > 0, `plugin 注入事件数 ${pluginUsers.length}`)
      eq(turns.every((x) => log.events[x.userSeq].data.source.kind === 'user'), true, '每轮都源自真实用户消息')
    })
    t('真机：真实提问里没有夹带注入块（保险层零命中 = 正确）', () => {
      eq(turns.reduce((a, x) => a + x.injectedBlocks, 0), 0, '真实用户消息不应含注入块')
    })
    t('真机回答不含 reasoning 文本', () => {
      for (const turn of turns) ok(!/"reasoning"/.test(turn.answerText), `轮 ${turn.turnIndex}`)
    })
    const pluginUsers = log.events.filter((e) => e.type === 'user/message' && e.data?.source?.kind !== 'user')
    const pluginChars = pluginUsers.reduce((a, e) => a + textOfBlocks(e.data?.content, { placeholders: false }).length, 0)
    const qChars = turns.reduce((a, x) => a + x.userText.length, 0)
    const aChars = turns.reduce((a, x) => a + x.answerText.length, 0)
    console.log(`\n  会话 ${TARGET}`)
    console.log(`  ${log.events.length} 事件 / ${log.frames} 帧 · 完成轮 ${turns.length}`)
    console.log(`  排除 plugin 注入事件 ${pluginUsers.length} 条 / ${pluginChars.toLocaleString('en-US')} 字符（不进取抽输入）`)
    console.log(`  抽取输入合计：Q ${qChars.toLocaleString('en-US')} 字 + A ${aChars.toLocaleString('en-US')} 字`)
    const show = (label, turn) => {
      console.log(`  ${label} Q(${turn.userText.length}字): ${turn.userText.replace(/\s+/g, ' ').slice(0, 70)}`)
      console.log(`  ${label} A(${turn.answerText.length}字): ${turn.answerText.replace(/\s+/g, ' ').slice(0, 70)}`)
    }
    show('轮 1 ', turns[0])
    if (turns.length > 1) show(`轮 ${turns.length}`, turns[turns.length - 1])
    realOk = true
  }
  t('帧魔数扫描可用', () => ok(frameOffsets(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x28, 0xb5, 0x2f, 0xfd])).length === 2))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${realOk ? '（含真机会话）' : ''}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
