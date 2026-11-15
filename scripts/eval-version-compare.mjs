// 1.1.0 / 1.2.0 检索对照（2026-11-15 GPT 评审第 3 件）
// 做法：直接 import 插件的 searchMemory，用配置开关模拟两版，跑回放集 20 题。
// 1.1.0 模拟 = 关时间衰减 + 无 facts + 无图谱；1.2.0 = 当前默认全开。
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  ensureIndex, searchMemory, loadGraph,
} from 'file:///G:/大肥鱼生产基地/_integrate/dsh-memory-semantic/lib/index.js'
import { normalizeConfig } from 'file:///G:/大肥鱼生产基地/_integrate/dsh-memory-semantic/lib/config.js'

const WS = 'G:/大肥鱼生产基地'
const TMP_WS = 'G:/大肥鱼生产基地/_tmp/eval-ws' // 账本写到临时目录，不污染真账本
const CASES = JSON.parse(readFileSync(path.join(WS, '功能开发/记忆评估/回放集-v0.json'), 'utf8')).cases

const logger = { info() {}, warn() {}, error() {}, debug() {} }
try { mkdirSync(path.join(TMP_WS, '.dsh-semantic'), { recursive: true }) } catch { /* ignore */ }
const dbFile = path.join(WS, '.dsh-meow', 'memory.db')

console.log(`cases=${CASES.length}, 准备索引…`)
const baseCfg = normalizeConfig({})
const { idx, rows } = await ensureIndex(WS, dbFile, logger, baseCfg)
console.log(`索引 ${Object.keys(idx.entries).length} 条 / 记忆库 ${rows.length} 条`)

let factsFull = { triples: [] }
try {
  factsFull = JSON.parse(readFileSync(path.join(WS, '.dsh-semantic', 'facts.json'), 'utf8'))
} catch { /* 没有就空 */ }
const graphFull = loadGraph(WS)
console.log(`facts ${factsFull.triples?.length || 0} 条 / 图谱 ${graphFull ? graphFull.nodeCount + ' 节点' : '无'}`)

// 两版 ctx
const v110 = {
  cfg: { ...baseCfg, retrieval: { ...baseCfg.retrieval, recencyHalfLife: 0 } },
  index: { idx, rows }, ollamaOk: true, graph: null, facts: { triples: [] },
}
const v120 = {
  cfg: baseCfg,
  index: { idx, rows }, ollamaOk: true, graph: graphFull, facts: factsFull,
}

function hit(contents, expected) {
  const joined = contents.join('\n')
  return expected.some((e) => joined.includes(e))
}

async function run(ctx, c) {
  const out = await searchMemory(ctx, { query: c.question, k: 5 }, logger, TMP_WS)
  const texts = (out.results || []).map((r) => String(r.content || ''))
  return { top1: texts.slice(0, 1), top3: texts.slice(0, 3), topk: texts }
}

const rows110 = []
const rows120 = []
for (const c of CASES) {
  const a = await run(v110, c)
  const b = await run(v120, c)
  const ah1 = hit(a.top1, c.expected_contains), ah3 = hit(a.top3, c.expected_contains)
  const bh1 = hit(b.top1, c.expected_contains), bh3 = hit(b.top3, c.expected_contains)
  rows110.push({ id: c.id, h1: ah1, h3: ah3 })
  rows120.push({ id: c.id, h1: bh1, h3: bh3 })
  const mark = ah3 === bh3 ? (ah1 === bh1 ? '  ' : (bh1 ? '↑1' : '↓1')) : (bh3 ? '↑3' : '↓3')
  console.log(`${mark} ${c.id}  1.1.0 h1=${ah1 ? 'Y' : 'n'} h3=${ah3 ? 'Y' : 'n'} | 1.2.0 h1=${bh1 ? 'Y' : 'n'} h3=${bh3 ? 'Y' : 'n'}`)
}

const sum = (rows) => ({ h1: rows.filter((r) => r.h1).length, h3: rows.filter((r) => r.h3).length })
const s1 = sum(rows110), s2 = sum(rows120)
console.log(`\n===== 汇总 =====`)
console.log(`1.1.0: Hit@1 ${s1.h1}/${CASES.length} = ${(s1.h1 / CASES.length * 100).toFixed(0)}% | Hit@3 ${s1.h3}/${CASES.length} = ${(s1.h3 / CASES.length * 100).toFixed(0)}%`)
console.log(`1.2.0: Hit@1 ${s2.h1}/${CASES.length} = ${(s2.h1 / CASES.length * 100).toFixed(0)}% | Hit@3 ${s2.h3}/${CASES.length} = ${(s2.h3 / CASES.length * 100).toFixed(0)}%`)
const better = rows120.filter((r, i) => r.h3 && !rows110[i].h3).map((r) => r.id)
const worse = rows120.filter((r, i) => !r.h3 && rows110[i].h3).map((r) => r.id)
console.log(`改善（1.2.0 进 top3 而 1.1.0 没进）: ${better.length ? better.join(', ') : '无'}`)
console.log(`退步（1.1.0 进 top3 而 1.2.0 没进）: ${worse.length ? worse.join(', ') : '无'}`)
