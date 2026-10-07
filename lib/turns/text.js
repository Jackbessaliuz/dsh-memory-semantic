/**
 * text —— 轮次召回用的轻量文本工具（BM25 / token / 余弦）
 *
 * 与 dsh-memory-semantic 记忆条目层 `lib/index.js` 的实现同源（同一套中文 bigram 分词，
 * 保证两层检索表现一致）。这里独立成文件，是为了让 turn 层自包含、可离线单测，
 * 不把记忆条目层的模块图拖进来；将来若合并进上游，两处可统一。
 */

/** 中文按字符 bigram + 英文数字词。 */
export function tokenize(text) {
  const t = String(text ?? '').toLowerCase()
  const tokens = []
  tokens.push(...(t.match(/[a-z0-9_]+/g) || []))
  const zh = t.replace(/[a-z0-9_\s]+/g, '')
  for (let i = 0; i < zh.length - 1; i += 1) tokens.push(zh.slice(i, i + 2))
  return tokens
}

/** BM25（k1=1.5, b=0.75），docs: [{ id, text }] → score(query) → [{ id, score }] 降序。 */
export function buildBM25(docs) {
  const N = docs.length
  const tfs = []
  const df = new Map()
  let totalLen = 0
  for (const doc of docs) {
    const toks = tokenize(doc.text)
    const m = new Map()
    for (const tok of toks) m.set(tok, (m.get(tok) ?? 0) + 1)
    totalLen += toks.length
    for (const tok of m.keys()) df.set(tok, (df.get(tok) ?? 0) + 1)
    tfs.push({ id: doc.id, m, len: toks.length })
  }
  const avgdl = totalLen / Math.max(N, 1) || 1
  const k1 = 1.5
  const b = 0.75
  return function score(query) {
    const qTokens = [...new Set(tokenize(query))]
    const out = []
    for (const doc of tfs) {
      let s = 0
      for (const tok of qTokens) {
        const f = doc.m.get(tok)
        if (!f) continue
        const idf = Math.log(1 + (N - (df.get(tok) ?? 0) + 0.5) / ((df.get(tok) ?? 0) + 0.5))
        s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * doc.len) / avgdl))
      }
      if (s > 0) out.push({ id: doc.id, score: s })
    }
    return out.sort((a, c) => c.score - a.score)
  }
}

export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

/**
 * Reciprocal-rank fusion：两条路线的原始分数不可直接相加（cosine 与 PageRank 不同量纲），
 * 用排名倒数融合；同一轮被两条路线同时支持时自然上升。
 *
 * weights 可给每条路线单独配权——**等权融合会把强路线的正确结果挤下去**
 * （2026-09-23 实测：head12 场景等权融合 R@1 60.8% < 纯 BM25 86.1%），
 * 所以默认由调用方给权重，缺省才用 1。
 */
export function rrfRank(lists, pool = 10, K = 60, weights = []) {
  const ranks = new Map()
  lists.forEach((list, routeIndex) => {
    const weight = Number.isFinite(weights[routeIndex]) ? weights[routeIndex] : 1
    for (let i = 0; i < Math.min(list.length, pool); i += 1) {
      const { id } = list[i]
      const cur = ranks.get(id) ?? { rrf: 0, best: [] }
      cur.rrf += weight / (K + i + 1)
      cur.best[routeIndex] = i
      ranks.set(id, cur)
    }
  })
  return [...ranks.entries()]
    .map(([id, r]) => ({ id, score: r.rrf, routes: r.best }))
    .sort((a, c) => c.score - a.score)
}

/**
 * 把若干路线合成一个候选池（放在 text 层，便于评估脚本与召回共用同一套融合逻辑）。
 *
 * @param routes [{ name, list }]，list 为降序 [{ id, score }]
 * @param options.k 目标返回条数（门控模式的"够用"阈值）
 * @param options.pool 候选池大小
 * @param options.mode 'gated' | 'weighted'
 * @param options.weights 各路线权重（weighted 模式）
 */
export function fuseRoutes(routes, options = {}) {
  const live = (Array.isArray(routes) ? routes : []).filter((r) => r && Array.isArray(r.list) && r.list.length > 0)
  if (live.length === 0) return []
  const pool = Math.max(1, Number(options.pool) || 10)
  const k = Math.max(1, Number(options.k) || 5)
  const mode = options.mode ?? 'gated'
  const indexOf = (route) => live.indexOf(route)

  if (live.length === 1) {
    return live[0].list.slice(0, pool).map((x) => ({ id: x.id, score: x.score, routes: [indexOf(live[0])] }))
  }

  const lexical = live.find((r) => r.name === 'bm25')
  // 门控判据（2026-10-08 实测定型）：**"够多"还不够，得"够确信"**。
  // 只看条数（>= k）时关键词几乎总能凑够 → 语义永远进不了门；实测后果是
  // "换句话问"的场景有 14/65 条查询彻底找不到，而其中 9 条本可由语义救回。
  // 改用 top1/top2 的分数比（gap）：gap 大 = 第一名遥遥领先 = 可信；
  // gap 小 = 前两名咬得近 = 关键词在犹豫，交给加权融合让语义补位。
  const gateGap = Number.isFinite(options.gateGap) ? options.gateGap : 1.5
  const lexicalGap = lexical && lexical.list.length >= 2 && lexical.list[1].score > 0
    ? lexical.list[0].score / lexical.list[1].score
    : Infinity
  if (mode === 'gated' && lexical && lexical.list.length >= k && lexicalGap >= gateGap) {
    const merged = lexical.list.slice(0, pool).map((x) => ({ id: x.id, score: x.score, routes: [indexOf(lexical)] }))
    const seen = new Set(merged.map((m) => m.id))
    for (const route of live) {
      if (route === lexical) continue
      for (const hit of route.list.slice(0, pool)) {
        if (merged.length >= pool) break
        if (seen.has(hit.id)) continue
        seen.add(hit.id)
        merged.push({ id: hit.id, score: hit.score, routes: [indexOf(route)] })
      }
    }
    return merged
  }

  const weights = live.map((r) => (Number.isFinite(options.weights?.[r.name]) ? options.weights[r.name] : 1))
  return rrfRank(live.map((r) => r.list), pool, 60, weights)
}
