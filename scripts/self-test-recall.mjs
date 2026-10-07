/**
 * 自测：召回门控与回声标记（lib/turns/recall.js 的 2026-09-24 新增部分）
 * 跑法：node scripts/self-test-recall.mjs（离线，不碰 Ollama）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  informativeLength, shouldRecall, detectEcho, recallTurns, stripNonContent, lexicalRoute, hasHistoryHint,
} from '../lib/turns/recall.js'
import { assembleRecall } from '../lib/turns/assemble.js'
import { openTurnsDb } from '../lib/turns/schema.js'
import { upsertTurn, replaceTriples } from '../lib/turns/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(here, '..', '_tmp', 'self-test-recall')

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

function freshWorkspace(name) {
  const dir = path.join(TMP, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function seed(db, { sessionId, turnIndex, userSeq, answerSeq, userText, answerText, triples = [] }) {
  const record = upsertTurn(db, { sessionId, turnIndex, summary: `${userText} → ${answerText}`, outcome: 'completed', userSeq, answerSeq, userText, answerText })
  if (triples.length) replaceTriples(db, record.id, sessionId, triples)
  return record
}

console.log('\n【查询门控：这句话值不值得翻历史】')
t('真机那条：剥掉表情与寒暄后只剩 2 个实义字', () => {
  eq(informativeLength('我已重启，继续吧 [表情: 不愧是你！眼光真棒！（开心夸赞）]'), 2)
  ok(!shouldRecall('我已重启，继续吧 [表情: 继续加油]'), '应被门控挡掉')
})
t('纯寒暄与空查询被挡', () => {
  for (const q of ['继续', '好的', '嗯嗯', '谢谢', '接着说吧', '', '   ', '[表情: 开心]']) {
    ok(!shouldRecall(q), `「${q}」应被挡`)
  }
})
t('有内容的提问通过（含技术短语/长句）', () => {
  for (const q of ['上下文接管的折叠窗口取多少', 'turns.db 的回声怎么压', '为什么降权会让召回变差', 'dsh-memory-semantic 的 live sink 水位']) {
    ok(shouldRecall(q), `「${q}」应通过`)
  }
})
t('门槛可配：minQueryChars=0 时一律放行', () => {
  ok(shouldRecall('嗯', { minQueryChars: 0 }))
  ok(!shouldRecall('这是四个字', { minQueryChars: 999 }))
})
t('门控不受大小写/全角标点影响', () => {
  eq(informativeLength('OK，继续吧！！'), 0)
  ok(shouldRecall('BM25 融合权重'))
})

console.log('\n【回声标记（只标记，默认不降权）】')
t('记忆 id / 记忆工具名 / 归档动作 / 提交号都判为回声', () => {
  eq(detectEcho('新增两条记录（0mue1ne0、0mue1ne2）').label, 'memory-id')
  eq(detectEcho('用 memory_remember 写入').label, 'memory-tool')
  eq(detectEcho('本轮记忆整理完成，归档完成').label, 'memory-meta')
  eq(detectEcho('提交 34cae78 已固化').label, 'commit-talk')
})
t('正常技术讨论不误判', () => {
  for (const text of ['折叠窗口取最近 8 轮', 'BM25 建在原文上，向量建在摘要上', '把 off/low/high/max 记下来']) {
    eq(detectEcho(text).factor, 1, `「${text}」不该被判回声`)
  }
})
t('最狠的规则生效（记忆 id 压过归档词）', () => {
  eq(detectEcho('记忆整理完成：0mue1ne0').label, 'memory-id')
})

console.log('\n【recallTurns 集成】')
t('短查询：门控短路，返回空且标记原因', () => {
  const ws = freshWorkspace('gate')
  const db = openTurnsDb(ws)
  seed(db, { sessionId: 'session-g', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '重启相关的一轮', answerText: '好' })
  const out = recallTurns(db, { query: '我已重启，继续吧', k: 5 })
  eq(out.results.length, 0)
  eq(out.diagnostics.gated, 'query-too-thin')
  ok(out.diagnostics.informative < 4)
  db.close()
})
t('默认：回声只标记、分数与顺序不变（降权关）', () => {
  const ws = freshWorkspace('no-penalty')
  const db = openTurnsDb(ws)
  seed(db, { sessionId: 'session-n', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '折叠窗口的取值', answerText: '答' })
  seed(db, { sessionId: 'session-n', turnIndex: 1, userSeq: 2, answerSeq: 3, userText: '记忆整理完成，新增 0mue1ne0', answerText: '整理完成' })
  const plain = recallTurns(db, { query: '折叠窗口的取值', k: 5, echoPenalty: false })
  const marked = recallTurns(db, { query: '折叠窗口的取值', k: 5 })
  eq(marked.results.map((r) => [r.turnId, r.score]), plain.results.map((r) => [r.turnId, r.score]), '分数与顺序都不该变')
  const echoHit = marked.results.find((r) => r.echo)
  if (echoHit) eq(echoHit.echo, 'memory-id', '命中的回声轮应带标记')
  db.close()
})
t('echoPenalty=true：降权生效（分数变小、带 rawScore）', () => {
  const ws = freshWorkspace('penalty')
  const db = openTurnsDb(ws)
  // 注意：轮次文本要够"厚"，否则会被内容门控（20 实义字）先过滤掉——那是在测另一件事
  seed(db, { sessionId: 'session-p', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '折叠窗口的取值该怎么定', answerText: '按最近几轮完整保留，更早的折叠成归档标记，需要时把原文召回插回当前提问之前。' })
  seed(db, { sessionId: 'session-p', turnIndex: 1, userSeq: 2, answerSeq: 3, userText: '折叠窗口相关的记忆整理完成，新增 0mue1ne0', answerText: '本轮把折叠窗口的讨论整理成记忆条目，并记下新增的条目编号与出处。' })
  const out = recallTurns(db, { query: '折叠窗口', k: 5, echoPenalty: true })
  const echoHit = out.results.find((r) => r.echo)
  ok(echoHit, '应能命中带回声标记的轮次')
  ok(echoHit.rawScore > echoHit.score, `降权后分数应更小（raw ${echoHit.rawScore} → ${echoHit.score}）`)
  ok(out.diagnostics.echoPenalized >= 1, '诊断应报降权条数')
  db.close()
})

console.log('\n【内容门控：命中轮自己没内容就不算命中】')
t('纯表情轮被剔除，实质轮留下（真机那条的形状）', () => {
  const ws = freshWorkspace('thin')
  const db = openTurnsDb(ws)
  seed(db, { sessionId: 'session-t', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '我重启回来了 [表情: 得意]', answerText: '[表情: 得意]' })
  seed(db, { sessionId: 'session-t', turnIndex: 1, userSeq: 2, answerSeq: 3, userText: '折叠窗口的取值应该怎么定', answerText: '按最近 N 轮完整保留，更早的折叠成归档标记，需要时召回原文插回。' })
  const loose = recallTurns(db, { query: '重启回来了，现在我该做什么操作协助你验证', k: 5, minTurnChars: 0, minQueryChars: 0 })
  const strict = recallTurns(db, { query: '重启回来了，现在我该做什么操作协助你验证', k: 5, minQueryChars: 0 })
  ok(loose.diagnostics.thinFiltered === 0, '关掉内容门控时不过滤')
  ok(strict.diagnostics.thinFiltered >= 1, '默认应过滤掉纯表情轮')
  ok(!strict.results.some((r) => informativeLength(r.userText) + informativeLength(r.answerText) < 20), '结果里不该再有 thin 轮')
  ok(loose.results.length >= strict.results.length, '过滤只会减少结果')
  db.close()
})
t('minTurnChars=0 时行为与旧版一致', () => {
  const ws = freshWorkspace('thin-off')
  const db = openTurnsDb(ws)
  seed(db, { sessionId: 'session-o', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '重启回来了', answerText: '[表情: 好]' })
  const out = recallTurns(db, { query: '重启回来了', k: 5, minTurnChars: 0, minQueryChars: 0 })
  eq(out.diagnostics.thinFiltered, 0)
  db.close()
})

console.log('\n【召回正文文案：不许说没发生的状态】')
t('未折叠时不说"已折叠"，折叠时才说', () => {
  const hit = [{ turnId: 't1', sessionId: 's', turnIndex: 0, score: 1, userText: '问句在此', answerText: '答句在此' }]
  const plain = assembleRecall(hit).text
  const folded = assembleRecall(hit, { folded: true }).text
  ok(!plain.includes('已折叠'), '预注入阶段不该说历史已折叠')
  ok(plain.includes('可能与眼前的历史重复'), '应说明可能与眼前重复')
  ok(folded.includes('已折叠'), '真折叠后才说已折叠')
})

console.log('\n【非内容标记剥离（表情标记会污染检索）】')
t('剥掉表情标记与图片/文件占位符，正文原样保留', () => {
  eq(stripNonContent('重启完成 [表情: 得意闭眼拳头，好耶]'), '重启完成')
  eq(stripNonContent('⟨image⟩ OK，问题解决了'), 'OK，问题解决了')
  eq(stripNonContent('正文一个字都不能少'), '正文一个字都不能少')
  eq(stripNonContent('[表情: 只有表情]'), '', '全是标记时只剩空白')
  eq(stripNonContent(undefined), '')
})
t('旧格式 [表情: 描述](url) 连 URL 一起剥（对齐 dsh-meme 的 MEME_TEXT_RE）', () => {
  eq(stripNonContent('走吧 [表情: 好的](https://example.com/a.png) 收工'), '走吧 收工')
  eq(stripNonContent('【表情: x】(http://img.cn/1.jpg)'), '【表情: x】(http://img.cn/1.jpg)', '全角括号不是该协议，不该误伤')
})
t('剥离后：带表情与不带表情的同一句话，命中完全一致', () => {
  const ws = freshWorkspace('strip')
  const db = openTurnsDb(ws)
  seed(db, { sessionId: 'session-s', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '重启完成 [表情: 得意闭眼拳头，好耶，小鲸鱼娘很满意]', answerText: '好的，这就开始本轮的记忆排查与修复工作。' })
  seed(db, { sessionId: 'session-s', turnIndex: 1, userSeq: 2, answerSeq: 3, userText: '把表情包功能再调一下 [表情: 得意闭眼拳头，好耶，小鲸鱼娘很满意]', answerText: '表情包的匹配逻辑已经调整完毕，稍后可以验收效果。' })
  seed(db, { sessionId: 'session-s', turnIndex: 2, userSeq: 4, answerSeq: 5, userText: '记忆召回的质量要再看看', answerText: '好的，我会把召回质量按真机样本逐条对照检查。' })
  const ids = db.prepare('SELECT id, session_id, user_seq FROM tm_turns').all()
    .map((r) => ({ id: String(r.id), sessionId: String(r.session_id), userSeq: Number(r.user_seq) }))
  const withMark = lexicalRoute(db, '重启完成 [表情: 得意闭眼拳头，好耶，小鲸鱼娘很满意]', ids)
  const without = lexicalRoute(db, '重启完成', ids)
  eq(withMark.map((x) => x.id), without.map((x) => x.id), '两种写法的排名应逐字相同')
  ok(withMark.length > 0 && without.length > 0, '都应有命中')
  ok(withMark[0]?.score < 20, `分数不应被标记抬成几十（实际 ${withMark[0]?.score}）`)
  db.close()
})

console.log('\n【依赖历史的信号：短句也该翻书架（2026-09-25 补）】')
t('指代/追问类句子被认出来；纯"继续"不算（那是寒暄，relay 另有机制）', () => {
  for (const q of ['上次那个再讲讲', '我们之前说过什么', '这个东西怎么定的', '还记得那个吗', '回顾一下当时']) {
    ok(hasHistoryHint(q), `「${q}」应被认作依赖历史`)
  }
  for (const q of ['今天天气不错', '把那段代码重构一下', '折叠窗口取多少轮', '继续', '我已重启，继续吧']) {
    ok(!hasHistoryHint(q), `「${q}」不该被认作依赖历史`)
  }
})
t('依赖历史的短句放行，普通短句仍被挡', () => {
  // 门控 6 字：'上次那个继续' 剥完只剩 3 实义字，但它**最需要翻书架**
  ok(informativeLength('上次那个继续') < 6, '前提：实义字确实少于门槛')
  ok(shouldRecall('上次那个继续', { minQueryChars: 6 }), '带历史信号 → 放行')
  ok(!shouldRecall('重启完毕，我回来了', { minQueryChars: 6 }), '普通寒暄 → 仍挡')
  ok(!shouldRecall('嗯嗯', { minQueryChars: 6 }), '太短且无信号 → 挡')
  ok(shouldRecall('上次', { minQueryChars: 6 }), '「上次」两字带信号 → 放行')
})
t('sessionId 前缀过滤：只搜指定会话', () => {
  const ws = freshWorkspace('session-filter')
  const db = openTurnsDb(ws)
  seed(db, { sessionId: 'session-aaa-1111', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '关于折叠窗口的讨论', answerText: '把更早的历史折叠成常量归档标记，需要时召回原文插回。' })
  seed(db, { sessionId: 'session-bbb-2222', turnIndex: 0, userSeq: 0, answerSeq: 1, userText: '关于折叠窗口的另一场讨论', answerText: '同样聊到折叠窗口，但这是另一个会话的记录。' })
  const all = recallTurns(db, { query: '折叠窗口', k: 5, minQueryChars: 0 })
  const onlyA = recallTurns(db, { query: '折叠窗口', k: 5, minQueryChars: 0, sessionId: 'session-aaa' })
  ok(all.results.length === 2, `全库应命中 2 条（实际 ${all.results.length}）`)
  ok(onlyA.results.length === 1, `限定会话应命中 1 条（实际 ${onlyA.results.length}）`)
  ok(String(onlyA.results[0].sessionId).startsWith('session-aaa'), '命中的应是限定会话')
  db.close()
})
t('折叠态文案要写明缺口怎么补（书签写清取法）', () => {
  const hit = [{ turnId: 't1', sessionId: 's', turnIndex: 0, score: 1, userText: '问句在此', answerText: '答句在此' }]
  const folded = assembleRecall(hit, { folded: true }).text
  ok(folded.includes('recall_turns'), '折叠后应告诉读者用 recall_turns 取回')
  ok(folded.includes('已折叠'), '应说明已折叠')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
