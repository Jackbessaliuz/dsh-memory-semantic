// α 上限对照（2026-11-16，GPT 要求"固定配置后回放 + 测未参与调参的问题"）
// 三组：A=关新特性（消融基线）/ B=新特性无上限 / C=新特性 α=0.10
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { ensureIndex, searchMemory, loadGraph } from 'file:///G:/大肥鱼生产基地/_integrate/dsh-memory-semantic/lib/index.js'
import { normalizeConfig } from 'file:///G:/大肥鱼生产基地/_integrate/dsh-memory-semantic/lib/config.js'

const WS = 'G:/大肥鱼生产基地'
const TMP = path.join(WS, '_tmp/eval-ws')
const CASES = JSON.parse(readFileSync(path.join(WS, '功能开发/记忆评估/回放集-v0.json'), 'utf8')).cases
const logger = { info() {}, warn() {}, error() {}, debug() {} }
const cfg0 = normalizeConfig({})
const { idx, rows } = await ensureIndex(WS, path.join(WS, '.dsh-meow', 'memory.db'), logger, cfg0)
let facts = { triples: [] }
try { facts = JSON.parse(readFileSync(path.join(WS, '.dsh-semantic', 'facts.json'), 'utf8')) } catch { /* 空 */ }
const graph = loadGraph(WS)
try { mkdirSync(path.join(TMP, '.dsh-semantic'), { recursive: true }) } catch { /* ignore */ }

const mk = (over) => ({ ...cfg0, retrieval: { ...cfg0.retrieval, ...over } })
const variants = [
  { name: 'A 消融(关新特性)', cfg: mk({ recencyHalfLife: 0, bonusAlpha: 0 }), facts: { triples: [] }, graph: null },
  { name: 'B 无上限', cfg: mk({ bonusAlpha: 0 }), facts, graph },
  { name: 'C α=0.10', cfg: mk({ bonusAlpha: 0.10 }), facts, graph },
]

function hitTexts(texts, exp) {
  const j = texts.join('\n')
  return exp.some((e) => j.includes(e))
}

const out = {}
for (const v of variants) {
  const rows2 = []
  for (const c of CASES) {
    const r = await searchMemory(
      { cfg: v.cfg, index: { idx, rows }, ollamaOk: true, graph: v.graph, facts: v.facts },
      { query: c.question, k: 5 }, logger, TMP,
    )
    const texts = (r.results || []).map((x) => String(x.content || ''))
    rows2.push({ id: c.id, h1: hitTexts(texts.slice(0, 1), c.expected_contains), h3: hitTexts(texts.slice(0, 3), c.expected_contains), top1: texts[0] ? texts[0].slice(0, 40) : '' })
  }
  out[v.name] = rows2
  const h1 = rows2.filter((x) => x.h1).length
  const h3 = rows2.filter((x) => x.h3).length
  console.log(`${v.name}: Hit@1 ${h1}/${CASES.length}  Hit@3 ${h3}/${CASES.length}`)
}

// 逐题对比 C vs B：哪些第一名变了
const b = out['B 无上限'], c = out['C α=0.10']
let changed = 0
console.log('\nC(α=0.10) 相对 B(无上限) 的变化：')
for (let i = 0; i < CASES.length; i += 1) {
  if (b[i].top1 === c[i].top1) continue
  changed += 1
  const gain = c[i].h3 && !b[i].h3 ? '改对' : (!c[i].h3 && b[i].h3 ? '改错' : '中性')
  console.log(`  ${CASES[i].id}: ${gain}  B.h1=${b[i].h1 ? 'Y' : 'n'} C.h1=${c[i].h1 ? 'Y' : 'n'}`)
}
if (changed === 0) console.log('  （没有第一名变化——α=0.10 下加成被压到不再改变排序）')
console.log(`\n第一名变化 ${changed} 题 / ${CASES.length}`)
