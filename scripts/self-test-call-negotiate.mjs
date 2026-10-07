/**
 * negotiateCallConfig 自测：宿主能力协商的四条路径
 * 跑法：node scripts/self-test-call-negotiate.mjs
 */
import assert from 'node:assert'
import { negotiateCallConfig } from '../lib/turns/live-sink.js'

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass += 1 } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}

const base = { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 4000 }
const quiet = () => {}

await t('宿主没有 resolveCallConfig → 原样返回（老宿主兼容）', async () => {
  const out = await negotiateCallConfig({ stream: () => {} }, base, quiet)
  assert.deepEqual(out, base)
  const out2 = await negotiateCallConfig(null, base, quiet)
  assert.deepEqual(out2, base)
})

await t('协商成功 → 采用宿主物化后的配置', async () => {
  const llm = { resolveCallConfig: async (cfg) => ({ ...cfg, maxTokens: 8192 }) }
  const out = await negotiateCallConfig(llm, base, quiet)
  assert.equal(out.maxTokens, 8192)
  assert.equal(out.reasoningEffort, 'high', '支持的档位应保留')
  assert.equal(out.provider, 'p')
})

await t('无 effort 时协商失败 → 沿用原配置（不抛）', async () => {
  const llm = { resolveCallConfig: async () => { throw new Error('boom') } }
  const out = await negotiateCallConfig(llm, { provider: 'p', model: 'm' }, quiet)
  assert.deepEqual(out, { provider: 'p', model: 'm' })
})

await t('档位不被支持 → 去掉 effort 重试（走适配器默认档）', async () => {
  const seen = []
  const llm = {
    resolveCallConfig: async (cfg) => {
      seen.push(cfg.reasoningEffort)
      if (cfg.reasoningEffort) throw new Error('route does not support reasoning effort "high"')
      return { ...cfg, maxTokens: 8192 }
    },
  }
  const out = await negotiateCallConfig(llm, base, quiet)
  assert.deepEqual(seen, ['high', undefined], '应先试原档、再去掉重试')
  assert.equal(out.reasoningEffort, undefined, '不支持的档位必须被丢掉')
  assert.equal(out.maxTokens, 8192)
})

await t('两次都失败 → 原样返回（交给上层 fail-open）', async () => {
  const llm = { resolveCallConfig: async () => { throw new Error('always') } }
  const out = await negotiateCallConfig(llm, base, quiet)
  assert.deepEqual(out, base)
})

await t('协商函数返回非对象 → 退化为原配置', async () => {
  const llm = { resolveCallConfig: async () => null }
  const out = await negotiateCallConfig(llm, base, quiet)
  assert.deepEqual(out, base)
})

console.log(`\nnegotiateCallConfig 自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
