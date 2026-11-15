// guard 判据自测（2026-11-15，GPT 评审要求补）
// 目的：证明「真实复读能判中」且「正常内容不会误判」——尤其数字/否定词变化的重复。
import { detect } from '../lib/guard/escape-valve.mjs'
import { rotationHit } from '../lib/guard/detect-v2.mjs'
import { findDegenerate } from '../lib/guard/thinking-guard.mjs'

let pass = 0, fail = 0
function check(name, hit, wantHit) {
  const ok = wantHit ? !!hit : !hit
  if (ok) { pass++; console.log(`  ✓ ${name} ${hit ? '(命中: ' + (hit.unit || '').slice(0, 20) + ')' : '(放行)'}`) }
  else { fail++; console.log(`  ✗ ${name} want=${wantHit ? 'hit' : 'pass'} got=${hit ? 'hit' : 'pass'}`) }
}

// ---------- 正样本：真实复读形态 ----------
const repeatLong = Array.from({ length: 30 }, () => '让我来写这个函数，先看看现有实现，然后补上参数校验和错误处理。').join('')
const rotationShort = Array.from({ length: 30 }, () => 'Let me write it. Go. Now. OK. Writing.').join(' ')
const repeatChinese = Array.from({ length: 45 }, () => '好的，我来做这一步。').join('')

// ---------- 负样本：正常内容 ----------
const normalLong = `我需要先确认这个改动的影响范围。第一步看 config.js 里的默认值，
第二步检查 searchMemory 的调用点，第三步跑自测。目前看时间衰减和 PPR 是独立的两个环节，
它们叠加时可能互相放大，所以要把分数分解出来看。另外 GPT 提到 RRF 的双路奖励是结构性的，
这一点我在实测里也观察到了：单路第 2 名拿 1/62，双路第 1 名拿 2/61，差距两倍。
结论是加权改不了相对顺序，需要换排序主键。`.repeat(3)

const codeBlock = '```js\nfunction searchMemory(ctx, args) {\n  const merged = rrfRank(a, b)\n  return merged.slice(0, k)\n}\n```\n' +
  '上面这个函数是检索主入口，注意它只做了融合和截断。'.repeat(6)

// 数字变化的重复（GPT：数字变化不能当同一段重复）
const numberVary = Array.from({ length: 30 }, (_, i) => `检查第 ${i + 1} 项配置，确认它没有被覆盖。`).join('')

// 否定变化的重复（GPT：否定词变化信息相反）
const negateVary = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? '这个方案可行，可以继续。' : '这个方案不可行，需要回退。')).join('')

// 正常英文写作
const normalEn = `The guard folds degenerate reasoning blocks out of the model-visible history.
It only touches steps whose tool calls are fully paired, and it never deletes the transcript.
The threshold was calibrated on twelve thousand real reasoning blocks, with a clear gap
between true positives and false positives. This is a statistical criterion, not a semantic one.`.repeat(4)

console.log('== 正样本（应命中）==')
const asContent = (text) => [{ type: 'reasoning', text }]
for (const [name, text] of [['长段复读(中文)', repeatLong], ['短句轮换(英文)', rotationShort], ['短句复读(中文)', repeatChinese]]) {
  check(name + ' [detect]', detect(text), true)
  check(name + ' [guard 默认路径]', findDegenerate(asContent(text))[0], true)
}

console.log('\n== 负样本（应放行）==')
for (const [name, text] of [
  ['正常中文推理', normalLong],
  ['代码块+说明', codeBlock],
  ['数字变化重复', numberVary],
  ['否定变化重复', negateVary],
  ['正常英文写作', normalEn],
]) {
  check(name + ' [detect]', detect(text), false)
  check(name + ' [guard 默认路径]', findDegenerate(asContent(text))[0], false)
}
console.log('\n== v2 单测（已知缺陷，默认不启用）==')
check('否定变化被 v2 单独误判（记录在案）', rotationHit(negateVary), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
