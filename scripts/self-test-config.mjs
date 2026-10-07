/**
 * config 自测：默认值 / 覆盖 / 非法值回退 / 越界钳制 / 环境变量优先 / 其它段不被吞
 * 跑法：node scripts/self-test-config.mjs
 */
import assert from 'node:assert'
import { normalizeConfig, DEFAULTS } from '../lib/config.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass += 1 } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}

t('空配置 → 全用默认值', () => {
  const c = normalizeConfig()
  assert.equal(c.graph.edgeThreshold, 0.62)
  assert.equal(c.retrieval.rrfK, 60)
  assert.equal(c.ollama.autoStart, false)
  assert.equal(c.ollama.model, 'bge-m3')
})

t('显式覆盖生效，未覆盖的仍为默认', () => {
  const c = normalizeConfig({ graph: { edgeThreshold: 0.7 }, ollama: { autoStart: true } })
  assert.equal(c.graph.edgeThreshold, 0.7)
  assert.equal(c.ollama.autoStart, true)
  assert.equal(c.retrieval.rrfK, 60)
  assert.equal(c.ollama.probeTimeoutMs, 800)
})

t('非法类型回退到默认', () => {
  const c = normalizeConfig({ graph: { edgeThreshold: 'abc' }, retrieval: { outputChars: null } })
  assert.equal(c.graph.edgeThreshold, DEFAULTS.graph.edgeThreshold)
  assert.equal(c.retrieval.outputChars, DEFAULTS.retrieval.outputChars)
})

t('越界值被钳制在合法区间', () => {
  const c = normalizeConfig({ retrieval: { rrfK: 99999 }, ollama: { probeTimeoutMs: -5, embedBatch: 0 } })
  assert.equal(c.retrieval.rrfK, 1000)
  assert.equal(c.ollama.probeTimeoutMs, 100)
  assert.equal(c.ollama.embedBatch, 1)
})

t('环境变量优先于 config', () => {
  process.env.MEMORY_SEMANTIC_MODEL = 'tmp-model'
  process.env.MEMORY_SEMANTIC_OLLAMA = 'http://127.0.0.1:9999'
  try {
    const c = normalizeConfig({ ollama: { model: 'explicit', url: 'http://x' } })
    assert.equal(c.ollama.model, 'tmp-model')
    assert.equal(c.ollama.url, 'http://127.0.0.1:9999')
  } finally {
    delete process.env.MEMORY_SEMANTIC_MODEL
    delete process.env.MEMORY_SEMANTIC_OLLAMA
  }
})

t('其它配置段原样保留（turns / actionTriggers 不被吞）', () => {
  const c = normalizeConfig({ turns: { live: { enabled: false } }, actionTriggers: { enabled: false }, custom: 1 })
  assert.equal(c.turns.live.enabled, false)
  assert.equal(c.actionTriggers.enabled, false)
  assert.equal(c.custom, 1)
})

t('queryInstruction 允许显式置空（不塞默认指令）', () => {
  const c = normalizeConfig({ retrieval: { queryInstruction: '' } })
  assert.equal(c.retrieval.queryInstruction, '')
})

console.log(`\nconfig 自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
