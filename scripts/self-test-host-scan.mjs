/**
 * host-scan 自测：压缩配置解析 / 三档建议 / YAML 片段 / 会话峰值扫描
 * 跑法：node scripts/self-test-host-scan.mjs
 */
import assert from 'node:assert'
import {
  parseCompactionFromPatch, readHostCompaction, yamlSnippet, COMPACTION_PRESETS,
  scanSessionPeaks, decompressFrames, dshHome,
} from '../lib/host-scan.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass += 1 } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}

t('parseCompactionFromPatch：没配 → 空对象', () => {
  const text = [
    '          - id: compaction-basic',
    "            name: '@deepseek-ai/dsh-compaction-basic'",
    '          - id: command-compact',
  ].join('\n')
  const out = parseCompactionFromPatch(text)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {})
})

t('parseCompactionFromPatch：配了 → 解析出类型正确的值', () => {
  const text = [
    '          - id: compaction-basic',
    '            config:',
    '              thresholdRatio: 0.9',
    '              retainRatio: 0.25',
    '              headroomTokens: 32768',
    '              auto: false',
    '          - id: command-compact',
  ].join('\n')
  const out = parseCompactionFromPatch(text)
  assert.deepEqual(out[0], { thresholdRatio: 0.9, retainRatio: 0.25, headroomTokens: 32768, auto: false })
})

t('parseCompactionFromPatch：不越界吃下一个条目的配置', () => {
  const text = [
    '          - id: compaction-basic',
    '          - id: tool-result-pruner',
    '            config:',
    '              thresholdChars: 8192',
  ].join('\n')
  const out = parseCompactionFromPatch(text)
  assert.deepEqual(out[0], {}, 'compaction-basic 没配就该是空')
})

t('readHostCompaction：本机能列出 profile 且带三档建议', () => {
  const r = readHostCompaction()
  assert.ok(Array.isArray(r.profiles))
  assert.equal(r.presets.length, 3)
  for (const p of r.profiles) {
    assert.ok(typeof p.effective.thresholdRatio === 'number', '应有生效值')
    assert.ok(typeof p.untouched === 'boolean')
  }
  console.log(`     （实测：${r.profiles.map((p) => `${p.profile}${p.untouched ? '(吃默认)' : '(有显式配置)'}`).join('  ') || '未找到 profile'}）`)
})

t('三档建议满足官方校验（retainRatio < thresholdRatio）', () => {
  for (const p of COMPACTION_PRESETS) {
    assert.ok(p.config.retainRatio < p.config.thresholdRatio, `${p.id} 不满足 retain<threshold`)
  }
})

t('yamlSnippet：能直接粘进 patch', () => {
  const s = yamlSnippet(COMPACTION_PRESETS[0])
  assert.ok(s.includes('id: compaction-basic'))
  assert.ok(s.includes('thresholdRatio: 0.9'))
  assert.ok(s.includes('retainRatio: 0.25'))
})

t('decompressFrames：垃圾输入不抛错', () => {
  assert.equal(decompressFrames(Buffer.from('not zstd at all')), '')
})

t('scanSessionPeaks：本机能扫（limit=2）', () => {
  const r = scanSessionPeaks({ limit: 2, tailBytes: 2 * 1024 * 1024 })
  assert.ok(Array.isArray(r.rows))
  assert.ok(typeof r.peakInputTokens === 'number')
  console.log(`     （实测：扫了 ${r.scanned} 个会话，峰值 ${r.peakInputTokens} tokens，压缩事件 ${r.compactionSeen ? '有' : '无'}）`)
})

console.log(`\nhost-scan 自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
