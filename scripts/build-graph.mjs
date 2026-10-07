/**
 * build-graph.mjs —— 薄壳：调用 lib/graph.js 的 buildGraph 构建记忆图谱
 * 用法：node scripts/build-graph.mjs [workspace]
 */
import path from 'node:path'
import { buildGraph } from '../lib/graph.js'

const WORKSPACE = process.argv[2] || process.cwd()
const DB_FILE = path.join(WORKSPACE, '.dsh-meow', 'memory.db')
const logger = { info: (m) => console.log(m) }

console.log('[build-graph] 构建记忆相似图（PageRank + 社区检测）...')
const t0 = Date.now()
const { graph, summary } = await buildGraph(WORKSPACE, DB_FILE, logger)
console.log(`[build-graph] 完成：节点 ${summary.nodeCount} / 边 ${summary.edgeCount} / 社区 ${summary.communityCount}（${Date.now() - t0}ms）`)
console.log(`[build-graph] 缺向量条目：${summary.missingVectors}`)
console.log('\n-- 全局 PageRank TOP 10 --')
summary.topPr.slice(0, 10).forEach((r, i) => console.log(`#${i + 1} [${r.score}] (${r.level}/${r.project}) ${r.content}`))
console.log('\n-- 社区分布 --')
summary.commSizes.forEach(({ cid, size }) => console.log(`${cid} (${size}条)`))
