// 查询分类器自测（2026-11-15）
import { classifyQuery } from '../lib/query-classify.js'

const cases = [
  ['插件市场里记忆类插件有多少个', 'fact'],
  ['DeepSeek OCR 多少钱一页', 'fact'],
  ['DSH 桌面端当前是什么版本', 'fact'],
  ['上次扫描市场时记忆类插件是多少个，最新的呢', 'fact'],
  ['为什么不用 Neo4j', 'topic'],
  ['智能体团队协作和 FEMO 有什么区别', 'topic'],
  ['我们为什么决定不上 Neo4j，现在版本多少', 'mixed'],
  ['但丁喜欢什么咖啡', 'topic'],
  ['max-effort 插件怎么工作的', 'topic'],
  ['记忆沙龙最近一次定的起点是什么', 'topic'],
]

let pass = 0
for (const [q, want] of cases) {
  const got = classifyQuery(q).type
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${got}] want=${want}  ${q}`)
}
console.log(`\n${pass}/${cases.length} passed`)
process.exit(pass === cases.length ? 0 : 1)
