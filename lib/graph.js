/**
 * graph.js —— 知识图谱二期：记忆相似图（PageRank / 社区检测 / 个性化PPR）
 *
 * 设计移植自 graph-memory（_integrate/_upstream/graph-memory）：
 *   - 全局 PageRank：        src/graph/pagerank.ts（computeGlobalPageRank，均匀 teleport + dangling 回收）
 *   - 社区检测：              src/graph/community.ts（Label Propagation，平局字典序最小）
 *   - 个性化 PPR：            src/graph/pagerank.ts（personalizedPageRank，teleport 回种子 + 种子权重）
 *   - 召回哲学（recall.ts）：图谱中心性是"离线检视/补充"信号，不顶替语义相似度排序。
 *
 * ⚠️ 与上游的两处有意偏离（2026-10-07 实测后改）：
 *   1. **边权参与计算**：上游按邻居个数等权传播。我们的图上实测等权会把 792 条记忆
 *      吞成 7 个社区（最大 88~95%），改按余弦权重传播后为 18~26 个（最大 45~79%）。
 *   2. **社区检测确定性**：上游用 Math.random 打乱以减震荡，代价是同一张图同参数
 *      两次跑出不同结果（实测 13 与 16 个社区）。这里固定按 id 升序遍历，结果可复现。
 *
 * 图来源（我们自己的记忆体系）：
 *   - 节点 = meow-memory 活跃条目（readMemories）
 *   - 边   = bge-m3 向量余弦近邻（top-k + 阈值），复用向量索引
 *
 * 手写 bundle，无构建步骤；依赖仅 Node 内置。
 * 核心函数导出：buildGraph / loadGraph / personalizedPageRank —— 便于脚本直跑与将来合并进上游。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readMemories, ensureIndex, cosine } from './index.js'

// ---------- 构图参数 ----------
const TOP_K = 8              // 每节点最近邻 top-k
// 余弦阈值 0.62：2026-10-07 在 792 条真实记忆上扫出的拐点 ——
// 0.60 时最大社区占 50%，0.64 起社区碎成中位 2 条（相变发生在 0.62~0.64 之间）。
const EDGE_THRESHOLD = 0.62
const DAMPING = 0.85
const PR_ITERATIONS = 50
const LP_MAX_ITER = 50

export const GRAPH_PARAMS = { topK: TOP_K, edgeThreshold: EDGE_THRESHOLD, damping: DAMPING, pprIterations: PR_ITERATIONS }

export function graphPathOf(workspace) {
  return path.join(workspace, '.dsh-semantic', 'graph.json')
}

export function loadGraph(workspace) {
  if (!workspace) return null
  try {
    const gp = graphPathOf(workspace)
    if (!fs.existsSync(gp)) return null
    return JSON.parse(fs.readFileSync(gp, 'utf8'))
  } catch { return null }
}

function cosineOf(a, b) {
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

/**
 * 构建记忆相似图 + 全局 PageRank + 社区检测，写 <workspace>/.dsh-semantic/graph.json。
 * 返回 { graph, summary }；summary 含统计与 top 列表，供脚本/工具展示。
 */
export async function buildGraph(workspace, dbFile, logger, params = {}) {
  const gcfg = (params.cfg && params.cfg.graph) || {}
  const topK = params.topK || gcfg.topK || TOP_K
  const threshold = params.edgeThreshold ?? gcfg.edgeThreshold ?? EDGE_THRESHOLD
  const damping = params.damping ?? gcfg.damping ?? DAMPING
  const prIterations = params.prIterations ?? gcfg.prIterations ?? PR_ITERATIONS
  const lpMaxIter = params.lpMaxIter ?? gcfg.lpMaxIter ?? LP_MAX_ITER

  // 1. 索引同步（增量补嵌；Ollama 地址/模型/批大小由 cfg 决定，缺省走内置默认）
  const { idx, rows } = await ensureIndex(workspace, dbFile, logger, params.cfg)

  // 2. 构图：余弦近邻边
  const vectors = new Map()
  let missing = 0
  for (const r of rows) {
    const v = idx.entries[r.id]?.vector
    if (Array.isArray(v) && v.length > 0) vectors.set(r.id, v)
    else missing++
  }
  const ids = [...vectors.keys()]
  const edgeWeights = new Map()
  const keyOf = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  for (const id of ids) {
    const va = vectors.get(id)
    const cand = []
    for (const other of ids) {
      if (other === id) continue
      const s = cosineOf(va, vectors.get(other))
      if (s >= threshold) cand.push([other, s])
    }
    cand.sort((a, b) => b[1] - a[1])
    for (const [nb, s] of cand.slice(0, topK)) {
      const k = keyOf(id, nb)
      const prev = edgeWeights.get(k)
      if (prev === undefined || s > prev) edgeWeights.set(k, s)
    }
  }
  const edges = [...edgeWeights.entries()].map(([k, w]) => {
    const [a, b] = k.split('|')
    return [a, b, w]
  })

  // 3. 全局 PageRank（**加权**游走：边权＝余弦相似度，不是等权）
  //    2026-10-07 实测：无权时 792 节点会被 LP 吞成 7 个社区（最大 88~95%）；加权后 18~26 个。
  const adj = new Map(ids.map((id) => [id, []]))
  for (const [a, b, w] of edges) { adj.get(a).push([b, w]); adj.get(b).push([a, w]) }
  const N = ids.length
  let rank = new Map(ids.map((id) => [id, 1 / N]))
  for (let i = 0; i < prIterations; i++) {
    const teleport = (1 - damping) / N
    const newRank = new Map(ids.map((id) => [id, teleport]))
    let danglingSum = 0
    for (const [nodeId, nbrs] of adj) {
      if (nbrs.length === 0) { danglingSum += rank.get(nodeId); continue }
      const totalW = nbrs.reduce((s, [, w]) => s + w, 0) || nbrs.length
      const share = damping * rank.get(nodeId)
      for (const [nb, w] of nbrs) newRank.set(nb, newRank.get(nb) + (share * (w / totalW)))
    }
    if (danglingSum > 0) {
      const dc = (damping * danglingSum) / N
      for (const id of ids) newRank.set(id, newRank.get(id) + dc)
    }
    rank = newRank
  }
  const pr = rank

  // 4. Label Propagation 社区检测（**加权投票 ＋ 确定性遍历**）
  //    加权：邻居按边权累加，不再把小相似邻居和大相似邻居等同看待。
  //    确定性：去掉 Math.random 打乱（实测同阈值两次跑出 514 与 256 两个结果），
  //    固定按 id 升序遍历，同一张图永远得到同一个解。
  let label = new Map(ids.map((id) => [id, id]))
  const lpOrder = [...ids].sort()
  for (let iter = 0; iter < lpMaxIter; iter++) {
    let changed = false
    for (const nodeId of lpOrder) {
      const nbrs = adj.get(nodeId) || []
      if (nbrs.length === 0) continue
      const freq = new Map()
      for (const [nb, w] of nbrs) {
        const l = label.get(nb)
        freq.set(l, (freq.get(l) || 0) + w)
      }
      let bestLabel = label.get(nodeId)
      let bestCount = 0
      for (const [l, c] of freq) {
        if (c > bestCount || (c === bestCount && l < bestLabel)) { bestLabel = l; bestCount = c }
      }
      if (label.get(nodeId) !== bestLabel) { label.set(nodeId, bestLabel); changed = true }
    }
    if (!changed) break
  }
  const communities = new Map()
  for (const [nodeId, cid] of label) {
    if (!communities.has(cid)) communities.set(cid, [])
    communities.get(cid).push(nodeId)
  }
  const sortedComms = [...communities.entries()].sort((a, b) => b[1].length - a[1].length)
  const renameMap = new Map(sortedComms.map(([oldId], i) => [oldId, `c-${i + 1}`]))

  // 5. 写 graph.json
  const nodes = {}
  for (const id of ids) nodes[id] = { pr: Number(pr.get(id).toFixed(6)), community: renameMap.get(label.get(id)) }
  const graph = {
    builtAt: Date.now(),
    model: idx.model,
    dim: (idx.entries[ids[0]]?.vector || []).length,
    nodeCount: ids.length,
    edgeCount: edges.length,
    damping,
    pprIterations: prIterations,
    threshold,
    topK,
    nodes,
    edges,
    communities: Object.fromEntries([...renameMap.values()].map((cid) => [
      cid,
      [...communities.entries()].filter(([old]) => renameMap.get(old) === cid).flatMap(([, mem]) => mem),
    ])),
  }
  const gp = graphPathOf(workspace)
  fs.mkdirSync(path.dirname(gp), { recursive: true })
  fs.writeFileSync(gp + '.tmp', JSON.stringify(graph), 'utf8')
  fs.renameSync(gp + '.tmp', gp)

  // 统计摘要
  const byId = new Map(rows.map((r) => [r.id, r]))
  const topPr = [...pr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([id, s]) => ({ id, score: Number(s.toFixed(6)), level: byId.get(id)?.level || '', project: byId.get(id)?.project || '', content: String(byId.get(id)?.content || '').replace(/\s+/g, ' ').slice(0, 60) }))
  const commSizes = Object.entries(graph.communities).map(([cid, mem]) => ({ cid, size: mem.length })).sort((a, b) => b.size - a.size)
  return { graph, summary: { nodeCount: ids.length, edgeCount: edges.length, communityCount: Object.keys(graph.communities).length, missingVectors: missing, topPr, commSizes } }
}

/**
 * 个性化 PageRank（供检索增强用）：
 * 从 seedIds（查询命中，带权重）出发沿边传播；teleport 始终回到种子。
 * 返回 Map<id, score>（仅含 candidateIds 中传播到的节点）。
 * 哲学：只作重排/补强信号，不顶替语义相似度主排序。
 */
export function personalizedPageRank(graph, seedIds, seedWeights, { damping, iterations } = {}) {
  const d = damping ?? (graph.damping || DAMPING)
  const iters = iterations ?? (graph.pprIterations || PR_ITERATIONS)
  const nodes = graph.nodes || {}
  const idSet = new Set(Object.keys(nodes))
  if (idSet.size === 0) return new Map()
  // 无向邻接表（边数组 → adj）
  const adj = new Map()
  for (const id of Object.keys(nodes)) adj.set(id, [])
  for (const [a, b, w] of graph.edges || []) {
    if (!idSet.has(a) || !idSet.has(b)) continue
    adj.get(a).push([b, w ?? 1]); adj.get(b).push([a, w ?? 1])
  }
  const validSeeds = seedIds.filter((id) => idSet.has(id))
  if (validSeeds.length === 0) return new Map()
  const rawWeights = validSeeds.map((id) => Math.max(0, seedWeights?.get(id) ?? 1))
  const totalWeight = rawWeights.reduce((s, v) => s + v, 0) || validSeeds.length
  const teleport = new Map(validSeeds.map((id, i) => [id, rawWeights[i] / totalWeight]))
  let rank = new Map()
  for (const id of idSet) rank.set(id, teleport.get(id) ?? 0)
  for (let i = 0; i < iters; i++) {
    const newRank = new Map()
    for (const id of idSet) newRank.set(id, (1 - d) * (teleport.get(id) ?? 0))
    for (const [nodeId, nbrs] of adj) {
      if (nbrs.length === 0) continue
      const share = (rank.get(nodeId) || 0) * d
      if (share === 0) continue
      const totalW = nbrs.reduce((s, [, w]) => s + w, 0) || nbrs.length
      for (const [nb, w] of nbrs) newRank.set(nb, (newRank.get(nb) || 0) + share * (w / totalW))
    }
    // dangling 回种子
    let danglingSum = 0
    for (const id of idSet) {
      const nbrs = adj.get(id)
      if (!nbrs || nbrs.length === 0) danglingSum += rank.get(id) || 0
    }
    if (danglingSum > 0) {
      for (const sid of validSeeds) {
        newRank.set(sid, (newRank.get(sid) || 0) + d * danglingSum * (teleport.get(sid) ?? 0))
      }
    }
    rank = newRank
  }
  return rank
}
