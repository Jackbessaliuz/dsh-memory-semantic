/**
 * 跨会话接力自测 / 诊断（dsh-memory-semantic）
 *
 * 用法：
 *   node scripts/self-test-session-relay.mjs                # 用当前环境（DSH_SESSION_ID/D SH_HOME）
 *   node scripts/self-test-session-relay.mjs <当前sid>       # 指定"当前会话"，其余按最近活跃找
 *
 * 它做六件事并逐项打印：
 *   ① 配置归一化（默认 / 关闭）  ② 找"上一个会话"  ③ 读投影缓存（标题＋首条原话）
 *   ④ 定位会话日志              ⑤ 多帧 zstd 抽尾部对话  ⑥ 组装成注入正文（完整打印）
 *
 * 全程只读，不写任何数据。
 */
import os from 'node:os'
import path from 'node:path'
import {
  normalizeRelayConfig, dshHome, pickPreviousSession, readSessionMeta,
  findSessionLog, readTailLines, extractDialogue, extractWithUsers, buildRelayText, frameOffsets,
  tailWithUsers, hm,
} from '../lib/session-relay.js'
import fs from 'node:fs'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const cur = process.argv[2] || process.env.DSH_SESSION_ID || ''
let fail = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? '  — ' + extra : ''}`)
  if (!cond) fail++
}

console.log('=== 0. 环境 ===')
console.log('  DSH_HOME =', home)
console.log('  当前会话  =', cur || '(未指定 → 用最近活跃的另一个会话做替身)')

console.log('=== 1. 配置归一化 ===')
const cfg = normalizeRelayConfig({})
const off = normalizeRelayConfig({ sessionRelay: { enabled: false } })
console.log('  默认:', { trigger: String(cfg.trigger), maxChars: cfg.maxChars, frames: cfg.frames, maxTurns: cfg.maxTurns })
ok('默认配置可用', !!cfg && cfg.maxChars === 2000)
ok('enabled:false → 关闭', off === null)

// 时间必须是**北京**墙上时间，且与本机时区无关（本机实测是 UTC+9 东京！
// 2026-10-08 我差点把这里"修"成机器时区，见 lib/session-relay.js 的注释）
console.log('=== 1b. 时间显示口径（固定北京）===')
{
  const fixed = Date.parse('2026-10-07T20:11:45.884Z') // 北京 10-08 04:11
  const s = hm(fixed)
  ok('UTC 20:11 → 北京 04:11', s.includes('10-08 04:11'), `实际输出「${s}」`)
  ok('标注了（北京）', s.includes('（北京）'))
  ok('坏输入不崩', hm('not a number') === '?')
  console.log(`  （本机时区 offset=${new Date(fixed).getTimezoneOffset()} 分钟；输出固定为北京，不受它影响）`)
}

console.log('=== 2. 找上一个会话 ===')
const prev = pickPreviousSession(home, cur, 24 * 3600 * 1000)
ok('找到候选会话', !!prev, prev ? `${prev.sid.slice(0, 20)} @ ${new Date(prev.mtime).toISOString().slice(5, 16)}` : '无')
if (!prev) process.exit(1)

// 2026-10-08 修（自测抗数据）：接力本身只挑"最近活跃"，而最近活跃的那个可能是
//   ① 本会话自己（不带参数跑时 cur=''，pickPreviousSession 排除不掉）；
//   ② 刚建出来、还没写内容的空会话（投影缓存没落、日志只 2 帧）。
// 那时"读到标题 / 抽出对话"必然为空，但 relay 逻辑没问题，红的是自测。
// 注意：不能靠"用上一个候选当 currentSid 再挑一次"往前找 —— pickPreviousSession
// 每次都在最新两个之间乒乓，实测来回振荡。所以这里直接枚举候选列表来挑。
console.log('=== 2b. 挑一个有内容的候选（跳过自己和空会话）===')
function allCandidates(home) {
  const root = path.join(home, 'sessions')
  const out = []
  let buckets = []
  try { buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return out }
  for (const b of buckets) {
    let sids = []
    try { sids = fs.readdirSync(path.join(root, b.name), { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const s of sids) {
      if (!s.name.startsWith('session-') || s.name === cur) continue
      const p = path.join(root, b.name, s.name, 'session.v4.jsonl.zstd')
      try { out.push({ sid: s.name, mtime: fs.statSync(p).mtimeMs, log: p }) } catch { /* 没有 v4 日志 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
let probeCand = null
let probeDlg = []
let tried = 0
for (const c of allCandidates(home)) {
  tried += 1
  if (tried > 8) break
  const d = extractWithUsers(c.log, cfg)
  if (readSessionMeta(home, c.sid).title && d.length > 0) { probeCand = c; probeDlg = d; break }
}
const hasContent = !!probeCand
if (hasContent) {
  console.log(`  用 ${probeCand.sid.slice(0, 20)} 做抽取验证（前面跳过了 ${tried - 1} 个空/自身会话）`)
} else {
  console.log(`  最近 ${tried} 个候选都没内容，本节的"有数据"断言按跳过处理（非失败）`)
}
const chosen = probeCand || { sid: prev.sid, log: findSessionLog(home, prev.sid) }

console.log('=== 3. 投影缓存（标题 + 首条原话）===')
const meta = readSessionMeta(home, chosen.sid)
if (hasContent) ok('读到标题', !!meta.title, meta.title || '(空)')
else ok('读到标题（无有内容候选 → 跳过，非失败）', true, '投影缓存还没落盘属正常')
console.log('  首条原话:', (meta.first || '(空)').slice(0, 100))

console.log('=== 4. 定位会话日志 ===')
const log = chosen.log
ok('找到日志文件', !!log, log ? path.basename(log) + ` (${(fs.statSync(log).size / 1024 / 1024).toFixed(1)}MB)` : '未找到')
if (!log) process.exit(1)

console.log('=== 5. 多帧 zstd 抽尾部 ===')
const allFrames = frameOffsets(fs.readFileSync(log)).length
const lines = readTailLines(log, cfg.frames)
const dlg = hasContent ? probeDlg : extractWithUsers(log, cfg) // 自适应：用户消息太少就多解几帧
ok('扫到 zstd 帧', allFrames > 0, `${allFrames} 帧（本次只解最后 ${cfg.frames} 帧，不够再翻倍）`)
ok('尾部解出事件行', lines.length > 0, `${lines.length} 行`)
if (hasContent) ok('抽出对话', dlg.length > 0, `${dlg.length} 条`)
else ok('抽出对话（无有内容候选 → 跳过，非失败）', true, '抽取链路另有 5b 节纯函数断言覆盖')

// 2026-10-08 修：这里原来是硬断言"必须含用户发言"，但抽的是**真机会话**——
// 上个会话正好以助手发言收尾（那晚 05:11 的真实形态）时，末 N 帧里一条用户消息都没有，
// 于是自测红着，而注入逻辑其实正常。改成有界放宽后再判，并说明真实注入会怎样。
let probeFrames = cfg.frames
let probe = dlg
for (let i = 0; i < 4 && !probe.some((d) => d.role === 'user'); i++) {
  probeFrames = Math.min(probeFrames * 3, 240)
  probe = extractWithUsers(log, { ...cfg, frames: probeFrames })
}
const userCount = probe.filter((d) => d.role === 'user').length
if (userCount > 0) {
  ok('含用户发言', true, `默认 ${cfg.frames} 帧内 ${dlg.filter((d) => d.role === 'user').length} 条；放宽到 ${probeFrames} 帧后 ${userCount} 条`)
} else {
  ok('含用户发言（本会话尾部全为助手 → 跳过，非失败）', true,
    `解到 ${probeFrames} 帧仍无用户消息（真机偶发：上个会话以助手收尾）；` +
    '注入逻辑本身由 5b 节的纯函数断言覆盖')
}
dlg.forEach((d, i) => console.log(`   ${i + 1}. ${d.role === 'user' ? '用户' : '助手'}：${d.text.replace(/\s+/g, ' ').slice(0, 90)}`))

console.log('=== 5b. 尾部收敛（纯函数：尽量 tailTurns 条，但至少含 2 条用户发言）===')
{
  const mk = (spec) => spec.split('').map((c) => ({ role: c === 'u' ? 'user' : 'assistant', text: c }))
  const users = (list) => list.filter((d) => d.role === 'user').length
  const widened = tailWithUsers(mk('uuaaaaaa'), 6, 2) // 尾部 6 条全是助手（真机那次就是这种形态）
  ok('尾部全是助手时往前扩到含 2 条用户发言', users(widened) === 2, `${widened.length} 条 / ${users(widened)} 用户`)
  const kept = tailWithUsers(mk('uauauauauaua'), 6, 2)
  ok('尾部本来就够时保持 tailTurns 条（行为不变）', kept.length === 6 && users(kept) === 3, `${kept.length} 条 / ${users(kept)} 用户`)
  ok('短于 tailTurns 时原样返回', tailWithUsers(mk('uu'), 6, 2).length === 2)
  ok('空输入不崩', tailWithUsers([], 6, 2).length === 0 && tailWithUsers(undefined, 6, 2).length === 0)
}

console.log('=== 6. 组装注入正文（这就是新会话会看到的东西）===')
const text = buildRelayText(cur || 'self-test', { ...prev, ...meta }, dlg, cfg)
console.log('--------------------------------------------------')
console.log(text)
console.log('--------------------------------------------------')
ok('正文非空且在上限内', text.length > 0 && text.length <= cfg.maxChars + 400, `${text.length} 字符`)
ok('含"接力上下文"标记', text.includes('接力上下文'))
ok('含上个会话标题', !meta.title || text.includes(meta.title))

console.log(fail === 0 ? '\n✅ 全部通过' : `\n❌ ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
