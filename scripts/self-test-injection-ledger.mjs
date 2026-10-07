/**
 * injection-ledger 自测：id 抽取 / 文本压平 / 过滤与登记 / TTL 过期 / 容量上限 / 跨会话隔离
 * 跑法：node scripts/self-test-injection-ledger.mjs
 */
import assert from 'node:assert'
import { createLedger, extractMemoryIds, textOfMessages } from '../lib/injection-ledger.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass += 1 } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}

const ID_A = '0mtq5t58k-e824466d0be0461a92ec73be94'
const ID_B = '0muwi03hu-b4cba4801d82451cb76b078364'

t('extractMemoryIds：抓出注入块里的长 id', () => {
  const text = `[dsh : rules] [${ID_A}] 2026-09-28 [dsh : lesson] [${ID_B}] 2026-10-01`
  assert.deepEqual(extractMemoryIds(text).sort(), [ID_A, ID_B].sort())
})
t('extractMemoryIds：没有 id 的文本 → 空数组', () => {
  assert.deepEqual(extractMemoryIds('普通文本，没有标识符'), [])
  assert.deepEqual(extractMemoryIds(null), [])
})
t('extractMemoryIds：同一 id 出现多次只算一次', () => {
  assert.deepEqual(extractMemoryIds(`${ID_A} 和 ${ID_A}`), [ID_A])
})
t('textOfMessages：字符串 / content 字符串 / content 数组都能压平', () => {
  const text = textOfMessages([
    'plain',
    { content: 'as-string' },
    { content: [{ type: 'text', text: 'block-1' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: 'block-2' }] },
  ])
  assert.ok(text.includes('plain') && text.includes('as-string') && text.includes('block-1') && text.includes('block-2'))
  assert.ok(!text.includes('x'), '非文本块不应进入')
})

t('filter / remember：登记过的不再返回', () => {
  const led = createLedger()
  assert.deepEqual(led.filter('s1', [ID_A, ID_B]), [ID_A, ID_B], '未登记时全通过')
  led.remember('s1', [ID_A])
  assert.deepEqual(led.filter('s1', [ID_A, ID_B]), [ID_B], '登记过的被过滤')
  assert.deepEqual(led.filter('s1', [ID_A]), [], '全部登记过 → 空（调用方可据此不注入）')
})

t('跨会话隔离：s1 登记不影响 s2', () => {
  const led = createLedger()
  led.remember('s1', [ID_A])
  assert.deepEqual(led.filter('s2', [ID_A]), [ID_A])
})

t('observeText：能从"别人注入的文本"里学到 id', () => {
  const led = createLedger()
  led.observeText('s1', `【长期记忆】[fact] [${ID_A}] 内容…`)
  assert.deepEqual(led.filter('s1', [ID_A]), [], 'meow-memory 注入过的，我们就不再注入')
})

t('TTL：过期后允许重新注入', () => {
  let fakeNow = 1000
  const led = createLedger({ ttlMs: 100, now: () => fakeNow })
  led.remember('s1', [ID_A])
  assert.deepEqual(led.filter('s1', [ID_A]), [])
  fakeNow += 101
  assert.deepEqual(led.filter('s1', [ID_A]), [ID_A], '过了 TTL 应该重新允许')
})

t('容量上限：会话数超过 maxSessions 时丢最旧的', () => {
  const led = createLedger({ maxSessions: 2 })
  led.remember('s1', [ID_A])
  led.remember('s2', [ID_A])
  led.remember('s3', [ID_A])
  assert.equal(led.stats().sessions, 2, '应只保留 2 个会话')
  assert.deepEqual(led.filter('s1', [ID_A]), [ID_A], '最旧的 s1 已被丢弃')
  assert.deepEqual(led.filter('s3', [ID_A]), [], '最新的 s3 仍登记着')
})

t('空输入安全：remember([]) 是 no-op，filter([]) 返回空', () => {
  const led = createLedger()
  assert.equal(led.remember('s1', []), 0)
  assert.deepEqual(led.filter('s1', []), [])
  assert.equal(led.stats().entries, 0)
})

t('forget / dispose：清理不留痕', () => {
  const led = createLedger()
  led.remember('s1', [ID_A])
  assert.equal(led.forget('s1'), true)
  assert.deepEqual(led.filter('s1', [ID_A]), [ID_A])
  led.remember('s1', [ID_A])
  led.dispose()
  assert.equal(led.stats().entries, 0)
})

console.log(`\ninjection-ledger 自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
