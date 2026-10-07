/**
 * self-test-redact —— 密钥脱敏闸门自测（2026-10-06 随 redact.js 一起加）
 *
 * 它守的是"记忆库不再收明文密钥"这条线，所以用例要覆盖：
 *  - 各类真实密钥形态（GitHub / sk- / PAT / JWT / Bearer / 私钥块）
 *  - **幂等**（闸门会经过两道，重复跑必须不变）
 *  - **不误伤**（中文正文、代码、普通长词原样通过）
 *  - **先脱敏再截断**（截断顺序错了会漏出"半个密钥"，2026-10-06 见过这个形态）
 */
import assert from 'node:assert/strict'
import { redactSecrets, redactDeep, hasSecret, secretKinds } from '../lib/turns/redact.js'

let pass = 0
const failures = []
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`) }
  catch (error) { failures.push(`${name} → ${error.message}`); console.log(`  ✗ ${name} → ${error.message}`) }
}

// 假密钥：形态真、值不真（重复字符，误当成真 token 也无价值）
const GH = `ghp_${'TESTONLY'.padEnd(36, '0')}`
const SK = `sk-${'9f8e7d6c5b4a3210'.repeat(2)}`
const PAT = `github_pat_${'A1b2C3d4E5'.repeat(6)}`
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`
const PEM = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${'x'.repeat(40)}\n-----END RSA PRIVATE KEY-----`
const BEARER = `Bearer ${'AbCdEfGhIjKlMnOpQrStUvWxYz012345'.repeat(1)}`

console.log('\n【密钥形态】')
check('GitHub token 被替换且原文不残留', () => {
  const out = redactSecrets(`我的 token 是 ${GH} 请收好`)
  assert.ok(!out.includes(GH), '原文残留')
  assert.match(out, /\[已脱敏:github-token\]/)
  assert.match(out, /我的 token 是 /, '上下文被破坏')
  assert.match(out, / 请收好/, '上下文被破坏')
})
check('sk- 密钥被替换', () => {
  const out = redactSecrets(`DEEPSEEK_API_KEY=${SK}`)
  assert.ok(!out.includes(SK))
  assert.match(out, /\[已脱敏:openai-style-key\]/)
})
check('github_pat_ 不被截断成 gh… 形态', () => {
  const out = redactSecrets(PAT)
  assert.ok(!out.includes('github_pat'))
  assert.match(out, /\[已脱敏:github-pat\]/)
})
check('JWT 被替换', () => {
  const out = redactSecrets(`Authorization: ${JWT}`)
  assert.ok(!out.includes(JWT))
})
check('Bearer 被替换', () => {
  const out = redactSecrets(BEARER)
  assert.ok(!out.includes(BEARER.slice(7)))
})
check('私钥块整体被替换', () => {
  const out = redactSecrets(`配置如下\n${PEM}\n结束`)
  assert.ok(!out.includes('MIIEowIBAAKCAQEA'))
  assert.match(out, /结束/, '块后内容被吃掉')
})
check('带标签的赋值只换值不换字段名', () => {
  const out = redactSecrets(`apiKey: ${SK}\npassword = ${'p'.repeat(24)}`)
  assert.match(out, /apiKey: \[已脱敏:/)
  assert.match(out, /password = \[已脱敏:/)
  assert.ok(!out.includes(SK))
})
check('一条消息里多把密钥都被清掉', () => {
  const out = redactSecrets(`A=${GH} B=${SK} C=${PAT}`)
  assert.ok(!out.includes(GH) && !out.includes(SK) && !out.includes(PAT))
})

console.log('\n【幂等与顺序】')
check('幂等：跑两次结果相同', () => {
  const once = redactSecrets(`token ${GH} 和 ${SK}`)
  assert.equal(redactSecrets(once), once)
})
check('幂等：脱敏标记本身不被再次改写', () => {
  const out = redactSecrets('[已脱敏:github-token]')
  assert.equal(out, '[已脱敏:github-token]')
})
check('先脱敏再截断：截断后不留半个密钥', () => {
  // shadow 的 queryHead 是 slice(0,100)。顺序错了就会切出 100 字符的密钥前缀
  const long = `${'前'.repeat(90)} ${GH} 尾巴`
  const wrong = redactSecrets(long).slice(0, 100)
  assert.ok(!wrong.includes('ghp_'), '正确顺序下不该出现密钥前缀')
})

console.log('\n【不误伤】')
check('普通中文正文原样通过', () => {
  const text = '某人今天写了项目文档的第三段，讲的是父子在码头告别。'
  assert.equal(redactSecrets(text), text)
  assert.equal(hasSecret(text), false)
})
check('代码片段不被误改', () => {
  const code = 'const x = compute(a, b); // 返回 sk 值'
  assert.equal(redactSecrets(code), code)
})
check('短词与普通英文段落不被误改', () => {
  const text = 'The quick brown fox jumps over the lazy dog. 1234567890'
  assert.equal(redactSecrets(text), text)
})
check('空串 / null / undefined / 非字符串原样返回', () => {
  assert.equal(redactSecrets(''), '')
  assert.equal(redactSecrets(null), null)
  assert.equal(redactSecrets(undefined), undefined)
  assert.equal(redactSecrets(42), 42)
})

console.log('\n【结构脱敏】')
check('redactDeep 处理嵌套对象/数组', () => {
  const input = {
    summary: `拿到了 ${GH}`,
    triples: [{ subject: '助手', predicate: '持有', object: SK }],
    list: [`${PAT}`, 123, { deep: `Bearer ${'z'.repeat(30)}` }],
  }
  const out = redactDeep(input)
  const flat = JSON.stringify(out)
  assert.ok(!flat.includes(GH) && !flat.includes(SK) && !flat.includes(PAT))
  assert.equal(out.list[1], 123, '非字符串叶子被改动')
  assert.equal(out.triples[0].subject, '助手', '正常词项被改动')
  assert.equal(redactDeep(null), null)
})
check('secretKinds 只报告类型不报告值', () => {
  const kinds = secretKinds(`x ${GH} y ${SK}`)
  assert.ok(kinds.includes('github-token') && kinds.includes('openai-style-key'))
  assert.equal(kinds.join(',').includes('ghp_'), false)
})

const total = pass + failures.length
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
