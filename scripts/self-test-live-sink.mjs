/**
 * 自测：异步写入链接线（lib/turns/live-sink.js）
 * 跑法：node scripts/self-test-live-sink.mjs
 *
 * 全程离线：假 session（按 seq 给事件）+ 假 llm（给 StreamChunk 流）+ 临时 sqlite。
 * 不调用任何真实模型、不碰 DSH 数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeLiveConfig, locateTurn, nextTurnIndex, resolveRoute, toHostMessages,
  createSinkRuntime, registerLiveSink,
} from '../lib/turns/live-sink.js'
import { openTurnsDb } from '../lib/turns/schema.js'
import { getTurn, turnIdOf, statsOf, getTriplesForTurn, enqueueExtraction, extractionQueueStats } from '../lib/turns/store.js'
import { streamOf } from '../lib/turns/extract-runner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(here, '..', '_tmp', 'self-test-live-sink')

let pass = 0
let fail = 0
const failures = []
function t(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    fail += 1; failures.push(name + ' → 异步用例必须放进 asyncTests')
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

/* ── 夹具 ─────────────────────────────────────────────────────────── */

/** 独立工作区（每次都清空，避免用例互相污染）。 */
function freshWorkspace(name) {
  const dir = path.join(TMP, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const VALID = JSON.stringify({
  summary: '轮次记忆链接线已接上宿主。',
  outcome: 'completed',
  triples: [{ subject: '轮次记忆', predicate: '接上', object: '宿主链接线' }],
})
function toolCallChunks(raw = VALID) {
  return [
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'submit_result', argumentsDelta: raw },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'submit_result', arguments: raw } },
    { type: 'usage', usage: { inputTokens: 1500, outputTokens: 320 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
const proseChunks = () => [
  { type: 'text-delta', index: 0, text: '好的，我完成了抽取。' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 假 llm：记录每次调用参数，按 chunksFor 决定返回哪条流。 */
function fakeLlm(chunksFor = () => toolCallChunks()) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return streamOf(typeof chunksFor === 'function' ? chunksFor(options, calls.length) : chunksFor)()
    },
  }
}

/** 假 session：只实现 live-sink 真正用到的那几个只读入口。 */
function fakeSession({ id, cwd, events = [], route = { provider: 'deepseek', model: 'deepseek-flash' }, origin } = {}) {
  // 宿主按 seq 索引事件（seq 连续、0 起）；夹具按同样规则铺一遍，避免测试自己的下标错觉。
  const indexed = []
  for (const event of events) indexed[event.seq] = event
  return {
    header: { id, cwd, ...(origin ? { origin } : {}) },
    eventAt: (seq) => indexed[seq],
    requestHeader: () => (route ? { config: route } : undefined),
  }
}

/* 事件构造 */
const userMsg = (seq, text, kind = 'user') => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } })
const answerMsg = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const toolOnlyAnswer = (seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 't', name: 'x', arguments: '{}' }] } } })
const turnEnd = (seq, turn = 1) => ({ seq, type: 'turn/end', data: { turn, reason: { kind: 'stop' } } })

/** 等异步链跑完（onSessionEvent 是 fire-and-forget 的）。 */
async function settle() {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/* ── 同步用例 ─────────────────────────────────────────────────────── */

console.log('\n【配置】')
t('默认开启：enabled 缺省为真，maxTokens 4000，并发 2', () => {
  const cfg = normalizeLiveConfig(undefined)
  ok(cfg, '默认应开启')
  eq([cfg.maxTokens, cfg.concurrency, cfg.priorTurns, cfg.vector, cfg.mainSessionsOnly], [4000, 2, 3, true, true])
  eq([cfg.provider, cfg.model, cfg.reasoningEffort], [null, null, null])
})
t('turns.live.enabled=false → 关（返回 null）', () => {
  eq(normalizeLiveConfig({ turns: { live: { enabled: false } } }), null)
})
t('覆盖 provider/model/effort，其余保持默认', () => {
  const cfg = normalizeLiveConfig({ turns: { live: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' } } })
  eq([cfg.provider, cfg.model, cfg.reasoningEffort, cfg.maxTokens], ['deepseek', 'deepseek-flash', 'off', 4000])
})
t('数值越界被夹住（maxTokens / concurrency / priorTurns）', () => {
  const cfg = normalizeLiveConfig({ turns: { live: { maxTokens: 1, concurrency: 99, priorTurns: 50 } } })
  eq([cfg.maxTokens, cfg.concurrency, cfg.priorTurns], [256, 8, 10])
})
t('vector/mainSessionsOnly 可关', () => {
  const cfg = normalizeLiveConfig({ turns: { live: { vector: false, mainSessionsOnly: false } } })
  eq([cfg.vector, cfg.mainSessionsOnly], [false, false])
})

console.log('\n【locateTurn：从 turn/end 往前定位本轮】')
t('单轮：user(0) + answer(1) + turn/end(2)', () => {
  const events = [userMsg(0, '你好'), answerMsg(1, '你好呀'), turnEnd(2)]
  eq(locateTurn((i) => events[i], 2, 0), { userSeq: 0, answerSeq: 1 })
})
t('多个 assistant/message → 取最靠近末尾的那个', () => {
  const events = [userMsg(0, '问'), answerMsg(1, '早稿'), answerMsg(2, '终稿'), turnEnd(3)]
  eq(locateTurn((i) => events[i], 3, 0), { userSeq: 0, answerSeq: 2 })
})
t('plugin 注入的 user/message 不算真实用户轮', () => {
  const events = [userMsg(0, '【meow-memory 注入】', 'plugin'), userMsg(1, '真问题'), answerMsg(2, '答'), turnEnd(3)]
  eq(locateTurn((i) => events[i], 3, 0), { userSeq: 1, answerSeq: 2 })
})
t('本轮只有工具调用没有可见回答 → 无可抽取', () => {
  const events = [userMsg(0, '问'), toolOnlyAnswer(1), turnEnd(2)]
  eq(locateTurn((i) => events[i], 2, 0), { userSeq: null, answerSeq: null })
})
t('同一轮里多条真实用户消息 → 只认最后一条（前一条的回答被跳过）', () => {
  const events = [userMsg(0, '第一问'), answerMsg(1, '第一答'), userMsg(2, '补充'), answerMsg(3, '补充答'), turnEnd(4)]
  eq(locateTurn((i) => events[i], 4, 0), { userSeq: 2, answerSeq: 3 })
})
t('floor 挡住上一轮：不会把上一轮的 user 当本轮起点', () => {
  const events = [userMsg(0, '第一问'), answerMsg(1, '第一答'), turnEnd(2, 1), userMsg(5, '第二问'), answerMsg(6, '第二答'), turnEnd(7, 2)]
  const indexed = []
  for (const event of events) indexed[event.seq] = event
  eq(locateTurn((i) => indexed[i], 7, 2), { userSeq: 5, answerSeq: 6 })
})
t('floor 之后的空洞（eventAt 返回 undefined）→ 停止扫描', () => {
  const sparse = { 3: turnEnd(3), 2: answerMsg(2, '答') } // 0/1 缺失
  eq(locateTurn((i) => sparse[i], 3, 0), { userSeq: null, answerSeq: 2 })
})

console.log('\n【nextTurnIndex / resolveRoute】')
t('空库 → 0；已有 0,1,2 → 3', () => {
  const ws = freshWorkspace('next-index')
  const db = openTurnsDb(ws)
  eq(nextTurnIndex(db, 'session-a'), 0)
  db.prepare(`INSERT INTO tm_turns (id,session_id,turn_index,summary,outcome,user_seq,answer_seq,user_text,answer_text,answer_hash,created_at,updated_at)
    VALUES ('x1','session-a',0,'s','completed',0,1,'u','a','h',0,0),
           ('x2','session-a',2,'s','completed',2,3,'u','a','h',0,0)`).run()
  eq(nextTurnIndex(db, 'session-a'), 3, 'max+1')
  eq(nextTurnIndex(db, 'session-b'), 0, '按会话隔离')
  db.close()
})
t('resolveRoute：header 提供 provider/model', () => {
  const session = fakeSession({ id: 'session-a', cwd: 'x', route: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' } })
  eq(resolveRoute(session, { provider: null, model: null, reasoningEffort: null }), { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' })
})
t('resolveRoute：配置覆盖 header；没有 header → null', () => {
  const session = fakeSession({ id: 'session-a', cwd: 'x', route: { provider: 'deepseek', model: 'flash' } })
  eq(resolveRoute(session, { provider: 'p2', model: 'm2', reasoningEffort: 'low' }), { provider: 'p2', model: 'm2', reasoningEffort: 'low' })
  eq(resolveRoute(fakeSession({ id: 's', cwd: 'x', route: null }), { provider: null, model: null, reasoningEffort: null }), null)
})

console.log('\n【toHostMessages】')
const asyncTests = [
  ['两条朴素消息 → 宿主 Message（id/role/content/source 齐全）', async () => {
    const out = await toHostMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }])
    eq(out.length, 2)
    eq([out[0].role, out[1].role], ['system', 'user'])
    ok(typeof out[0].id === 'string' && out[0].id.length > 0, 'id 非空')
    eq(out[0].content, [{ type: 'text', text: 'sys' }])
    eq(out[0].source.kind, 'system-prompt') // 2026-10-07 更正：v4 下宿主 system 消息的 source 形态（旧断言写的 plugin 形态早已不成立）
    ok(Object.isFrozen(out[0]) || typeof out[0] === 'object', '是对象')
  }],

  /* ── 集成：真 sqlite + 假 llm ─────────────────────────────────── */

  ['恢复巡检：首次跑、窗口内不重复、窗口外再来一次（2026-10-08 冷却滞留修复）', async () => {
    let clock = 1_700_000_000_000
    const ws = freshWorkspace('sweep')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({
      llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [], now: () => clock,
    })
    const session = fakeSession({
      id: 'session-sweep', cwd: ws,
      events: [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)],
    })

    // ① 第一次 turn/end：该工作区从没巡检过（last=0）→ 必须跑一次（＝启动恢复那一跳）
    runtime.onSessionEvent(session, turnEnd(2))
    await settle()
    eq(runtime.state().recoverSweeps, 1, '首次应巡检一次')

    // ② 紧接着再触发（距上次不到窗口）→ 不该重复
    clock += 60 * 1000
    runtime.onSessionEvent(session, turnEnd(2))
    await settle()
    eq(runtime.state().recoverSweeps, 1, '窗口内不该重复巡检')

    // ③ 越过窗口 → 再来一次：这正是修掉"冷却挡下的轮次滞留 6 小时"的那条路
    clock += 6 * 60 * 1000
    runtime.onSessionEvent(session, turnEnd(2))
    await settle()
    eq(runtime.state().recoverSweeps, 2, '窗口过后应再巡检一次')

    runtime.dispose()
  }],

  ['启动恢复：把上次没抽完的轮次从日志里捡回来（对齐上游"重启后继续抽"）', async () => {
    const ws = freshWorkspace('recover-queue')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })

    // ① 造一条"上次没抽完"的队列项：模拟宿主在抽取前重启、队列留在库里
    const db0 = openTurnsDb(ws)
    enqueueExtraction(db0, {
      sessionId: 'session-rec', turnIndex: 0, userSeq: 10, answerSeq: 11, workspace: ws,
      provider: 'deepseek', model: 'deepseek-flash',
    })
    eq(extractionQueueStats(db0).pending, 1, '应有 1 条待抽')
    db0.close()

    // ② 注入假 loader：假装会话日志里还留着那一轮（真环境里读的是 ~/.dsh/sessions）
    const fakeLog = () => ({
      turns: [{ turnIndex: 0, userSeq: 10, answerSeq: 11, userText: '上次没抽完的问题', answerText: '上次没抽完的回答' }],
    })
    await runtime.recoverDue(ws, fakeLog)

    // ③ 断言：轮次补进来了、队列状态转 succeeded、路由来自队列而不是 session
    const db1 = openTurnsDb(ws, { readOnly: true })
    eq(statsOf(db1).turns, 1, '轮次应被补进库')
    const row = db1.prepare('SELECT user_text, turn_index FROM tm_turns WHERE session_id=?').get('session-rec')
    eq(row?.user_text, '上次没抽完的问题', '补的是日志里的原文')
    eq(extractionQueueStats(db1).pending, 0, '队列应清空')
    eq(extractionQueueStats(db1).succeeded, 1, '应记为成功')
    db1.close()
    eq(llm.calls.length, 1, '恢复也应调用一次模型')
    eq([llm.calls[0].provider, llm.calls[0].model], ['deepseek', 'deepseek-flash'], '路由取自队列表（v5）')
    runtime.dispose()
  }],

  ['恢复：日志里也找不到那一轮 → 记成功不再重试（不做无谓烧钱）', async () => {
    const ws = freshWorkspace('recover-missing')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const db0 = openTurnsDb(ws)
    enqueueExtraction(db0, { sessionId: 'session-gone', turnIndex: 0, userSeq: 1, answerSeq: 2, workspace: ws, provider: 'p', model: 'm' })
    db0.close()
    await runtime.recoverDue(ws, () => ({ turns: [] }))
    const db1 = openTurnsDb(ws, { readOnly: true })
    eq(extractionQueueStats(db1).pending, 0, '队列应清空')
    eq(extractionQueueStats(db1).succeeded, 1, '应记为成功（跳过而非重试）')
    eq(llm.calls.length, 0, '不该调用模型')
    db1.close()
    runtime.dispose()
  }],

  ['恢复：积压多条时编号重新分配（实测踩过：两条都记成 #23）', async () => {
    const ws = freshWorkspace('recover-renumber')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const db0 = openTurnsDb(ws)
    // 模拟"抽取一直失败所以编号一直没推进"：两条待抽都记着同一个 turnIndex=23
    enqueueExtraction(db0, { sessionId: 'session-rn', turnIndex: 23, userSeq: 10, answerSeq: 11, workspace: ws, provider: 'p', model: 'm' })
    enqueueExtraction(db0, { sessionId: 'session-rn', turnIndex: 23, userSeq: 20, answerSeq: 21, workspace: ws, provider: 'p', model: 'm' })
    db0.close()
    const fakeLog = () => ({
      turns: [
        { turnIndex: 23, userSeq: 10, answerSeq: 11, userText: '第一轮积压', answerText: '答一' },
        { turnIndex: 23, userSeq: 20, answerSeq: 21, userText: '第二轮积压', answerText: '答二' },
      ],
    })
    await runtime.recoverDue(ws, fakeLog)
    const db1 = openTurnsDb(ws, { readOnly: true })
    const rows = db1.prepare('SELECT turn_index, user_text FROM tm_turns WHERE session_id=? ORDER BY turn_index').all('session-rn')
    eq(rows.map((r) => r.turn_index), [0, 1], '编号必须重新分配成 0/1，而不是重复的 23/23')
    eq(rows.map((r) => r.user_text), ['第一轮积压', '第二轮积压'], '内容按原顺序落库')
    eq(extractionQueueStats(db1).succeeded, 2, '两条都应记为成功')
    db1.close()
    runtime.dispose()
  }],

  ['恢复：队列表里没有路由 → 跳过（不瞎猜模型）', async () => {
    const ws = freshWorkspace('recover-noroute')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const db0 = openTurnsDb(ws)
    enqueueExtraction(db0, { sessionId: 'session-nr', turnIndex: 0, userSeq: 3, answerSeq: 4, workspace: ws })
    db0.close()
    await runtime.recoverDue(ws, () => ({ turns: [{ turnIndex: 0, userSeq: 3, answerSeq: 4, userText: 'q', answerText: 'a' }] }))
    eq(llm.calls.length, 0, '没有路由就不该调用模型')
    const db1 = openTurnsDb(ws, { readOnly: true })
    eq(extractionQueueStats(db1).pending, 1, '留在队列等下一次（人工修好配置后还会捡）')
    db1.close()
    runtime.dispose()
  }],
  ['一轮正常入库：turns / SPO / 向量 / turn_index=0', async () => {
    const ws = freshWorkspace('ok-single')
    const llm = fakeLlm()
    const embed = async (inputs) => inputs.map(() => [0.1, 0.2, 0.3])
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed })
    const events = [userMsg(0, '把链接线接上'), answerMsg(1, '已接上'), turnEnd(2)]
    await runtime.handle(fakeSession({ id: 'session-ok', cwd: ws, events }), events[2])
    const db = openTurnsDb(ws)
    const stats = statsOf(db)
    eq([stats.turns, stats.sessions, stats.triples, stats.vectors], [1, 1, 1, 1])
    const turn = getTurn(db, turnIdOf('session-ok', [0, 1]))
    ok(turn, '轮次应存在')
    eq([turn.turnIndex, turn.userSeq, turn.answerSeq, turn.outcome], [0, 0, 1, 'completed'])
    eq(turn.userText, '把链接线接上')
    eq(turn.answerText, '已接上')
    eq(getTriplesForTurn(db, turn.id).map((x) => [x.subject, x.predicate, x.object]), [['轮次记忆', '接上', '宿主链接线']])
    runtime.dispose(); db.close()
  }],

  ['抽取调用参数正确：provider/model/tools/messages', async () => {
    const ws = freshWorkspace('call-shape')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    await runtime.handle(fakeSession({ id: 'session-shape', cwd: ws, events, route: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' } }), events[2])
    eq(llm.calls.length, 1, '只调一次模型')
    const call = llm.calls[0]
    eq([call.provider, call.model, call.maxTokens], ['deepseek', 'deepseek-flash', 4000])
    eq(call.reasoningEffort, 'low', '抽取固定用温和档，不沿用会话档位（会话这里是 off）')
    eq(call.tools.map((x) => x.name), ['submit_result'])
    eq(call.messages.map((m) => m.role), ['system', 'user'])
    ok(String(call.messages[1].content[0].text).includes('问'), 'user prompt 含本轮提问')
    ok(!('toolChoice' in call) && !('tool_choice' in call), '不传 tool_choice')
    runtime.dispose()
  }],

  ['抽取档位不沿用会话：会话开 max（思考拉满），抽取仍走 low', async () => {
    const ws = freshWorkspace('effort-cap')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    await runtime.handle(fakeSession({ id: 'session-effort', cwd: ws, events, route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } }), events[2])
    eq(llm.calls[0].reasoningEffort, 'low', '会话是 max，抽取必须用 low')
    // 队列里仍记会话档位（便于追溯），但实际调用用的是覆盖后的档
    const db = openTurnsDb(ws, { readOnly: true })
    const q = db.prepare('SELECT effort FROM tm_extraction_queue LIMIT 1').get()
    eq(q?.effort, 'max', '队列保留会话档位用于追溯')
    db.close(); runtime.dispose()
  }],

  ['显式配置优先：turns.live.reasoningEffort=high 时不覆盖', async () => {
    const ws = freshWorkspace('effort-explicit')
    const llm = fakeLlm()
    const cfg = normalizeLiveConfig({ turns: { live: { reasoningEffort: 'high' } } })
    const runtime = createSinkRuntime({ llm, cfg, logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    await runtime.handle(fakeSession({ id: 'session-effort2', cwd: ws, events }), events[2])
    eq(llm.calls[0].reasoningEffort, 'high', '显式配置优先于默认档')
    runtime.dispose()
  }],

  ['幂等：同一轮再触发不重复花钱、不重复写', async () => {
    const ws = freshWorkspace('idempotent')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    const session = fakeSession({ id: 'session-idem', cwd: ws, events })
    await runtime.handle(session, events[2])
    await runtime.handle(session, events[2])
    await runtime.handle(session, events[2])
    eq(llm.calls.length, 1, '模型只被调用一次')
    const db = openTurnsDb(ws, { readOnly: true })
    eq(statsOf(db).turns, 1)
    db.close(); runtime.dispose()
  }],

  ['水位推进 + turnIndex 递增：第二轮接着写', async () => {
    const ws = freshWorkspace('two-turns')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '第一问'), answerMsg(1, '第一答'), turnEnd(2, 1), userMsg(3, '第二问'), answerMsg(4, '第二答'), turnEnd(5, 2)]
    const session = fakeSession({ id: 'session-two', cwd: ws, events })
    await runtime.handle(session, events[2])
    await runtime.handle(session, events[5])
    const db = openTurnsDb(ws, { readOnly: true })
    const rows = db.prepare('SELECT turn_index, user_text FROM tm_turns WHERE session_id=? ORDER BY turn_index').all('session-two')
    eq(rows.map((r) => [r.turn_index, r.user_text]), [[0, '第一问'], [1, '第二问']])
    eq(llm.calls.length, 2)
    db.close(); runtime.dispose()
  }],

  ['注入块剥离：plugin 注入不进 user_text', async () => {
    const ws = freshWorkspace('injection')
    const runtime = createSinkRuntime({ llm: fakeLlm(), cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [
      userMsg(0, '===== 长期记忆 =====\n一些注入内容', 'plugin'),
      userMsg(1, '真正的提问'),
      answerMsg(2, '回答'),
      turnEnd(3),
    ]
    await runtime.handle(fakeSession({ id: 'session-inj', cwd: ws, events }), events[3])
    const db = openTurnsDb(ws, { readOnly: true })
    const row = db.prepare('SELECT user_text FROM tm_turns WHERE session_id=?').get('session-inj')
    eq(row.user_text, '真正的提问')
    db.close(); runtime.dispose()
  }],

  ['抽取失败（模型吐散文）→ 不写库、水位仍推进、不抛', async () => {
    const ws = freshWorkspace('bad-extract')
    const llm = fakeLlm(() => proseChunks())
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    const session = fakeSession({ id: 'session-bad', cwd: ws, events })
    await runtime.handle(session, events[2]) // 不应抛
    const db = openTurnsDb(ws, { readOnly: true })
    eq(statsOf(db).turns, 0, '合同不满足就不该入库')
    db.close()
    const again = await runtime.handle(session, events[2])
    ok(again === undefined, '返回 undefined')
    eq(llm.calls.length, 1, '水位已推进 → 不再重试（回填兜底）')
    runtime.dispose()
  }],

  ['llm 抛错 → fail-open（不写库、不崩）', async () => {
    const ws = freshWorkspace('llm-throw')
    const llm = { calls: 0, stream() { this.calls += 1; throw new Error('网络断了') } }
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    await runtime.handle(fakeSession({ id: 'session-throw', cwd: ws, events }), events[2])
    eq(llm.calls, 1)
    const db = openTurnsDb(ws, { readOnly: true })
    eq(statsOf(db).turns, 0)
    db.close(); runtime.dispose()
  }],

  ['向量失败不影响入库', async () => {
    const ws = freshWorkspace('vector-fail')
    const runtime = createSinkRuntime({
      llm: fakeLlm(), cfg: normalizeLiveConfig(undefined), logger: null,
      embed: async () => { throw new Error('ollama 没开') },
    })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2)]
    await runtime.handle(fakeSession({ id: 'session-vec', cwd: ws, events }), events[2])
    const db = openTurnsDb(ws, { readOnly: true })
    const stats = statsOf(db)
    eq([stats.turns, stats.vectors], [1, 0], '轮次入库、向量缺失')
    db.close(); runtime.dispose()
  }],

  ['入口闸门：非 session- 前缀 / 子代理 / 非 turn/end 全部跳过', async () => {
    const ws = freshWorkspace('gates')
    const llm = fakeLlm()
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '问'), answerMsg(1, '答'), turnEnd(2), { seq: 3, type: 'step/end', data: {} }]
    runtime.onSessionEvent(fakeSession({ id: 'abc-uuid', cwd: ws, events }), events[2]) // 子代理风格 id
    runtime.onSessionEvent(fakeSession({ id: 'session-sub', cwd: ws, events, origin: 'subagent' }), events[2])
    runtime.onSessionEvent(fakeSession({ id: 'session-ok2', cwd: ws, events }), events[3])
    await settle()
    eq(llm.calls.length, 0, '三个都不该触发抽取')
    runtime.dispose()
  }],

  ['onSessionEvent 排队：连发两轮 → 串行跑完且都入库', async () => {
    const ws = freshWorkspace('queue')
    let running = 0
    let maxRunning = 0
    const llm = {
      calls: [],
      stream(options) {
        this.calls.push(options)
        running += 1
        maxRunning = Math.max(maxRunning, running)
        // 模拟慢调用：让并发有机会叠加
        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 30))
          running -= 1
          for (const chunk of toolCallChunks()) yield chunk
        })()
      },
    }
    const runtime = createSinkRuntime({ llm, cfg: normalizeLiveConfig(undefined), logger: null, embed: async () => [] })
    const events = [userMsg(0, '第一问'), answerMsg(1, '第一答'), turnEnd(2, 1), userMsg(3, '第二问'), answerMsg(4, '第二答'), turnEnd(5, 2)]
    const session = fakeSession({ id: 'session-queue', cwd: ws, events })
    runtime.onSessionEvent(session, events[2])
    runtime.onSessionEvent(session, events[5])
    await settle()
    eq(llm.calls.length, 2)
    eq(maxRunning, 1, '同会话必须串行')
    const db = openTurnsDb(ws, { readOnly: true })
    eq(statsOf(db).turns, 2)
    db.close(); runtime.dispose()
  }],

  ['registerLiveSink：注册进 ctx 且可关、可清理', async () => {
    const handlers = {}
    let disposed = 0
    const ctx = {
      get: (name) => (name === 'llm' ? fakeLlm() : undefined),
      on: (name, handler) => { handlers[name] = handler; return () => { disposed += 1 } },
      effect: (fn) => { const off = fn(); return off },
      logger: null,
    }
    const runtime = registerLiveSink(ctx, { logger: null, config: undefined })
    ok(runtime, '默认应注册')
    ok(typeof handlers['session/event'] === 'function', '应订阅 session/event')
    eq(registerLiveSink(ctx, { logger: null, config: { turns: { live: { enabled: false } } } }), null, '关掉时返回 null')
    const noLlm = { ...ctx, get: () => undefined }
    eq(registerLiveSink(noLlm, { logger: null, config: undefined }), null, '没有 llm 时不注册')
    runtime.dispose()
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
console.log(`（临时库根目录：${TMP}）`)
