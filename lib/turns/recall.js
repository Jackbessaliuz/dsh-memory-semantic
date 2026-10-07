/**
 * recall —— 轮次记忆召回（摘要路线 ＋ 图路线 ＋ 排名融合）
 *
 * 移植自 graph-memory 1.6.0-beta.16 的 `src/recaller/recall.ts` +
 * `src/graph/pagerank.ts`（personalizedNavigationPageRank）查询侧。
 *
 * 三条路线各自独立打分，最后用 reciprocal-rank fusion 合并：
 *  1. **词法路线**：BM25（中文 bigram）跑在轮次摘要上——零依赖、零成本、永远可用；
 *  2. **摘要路线**：查询向量 vs 摘要向量余弦（本地 bge-m3；不可达时该路线缺席）；
 *  3. **图路线**：查询里出现的词项作种子 → 在词项图上跑个性化 PageRank →
 *     按词项分数聚合回轮次（覆盖"具体实体/属性"这类字面命不中的检索）。
 *
 * 哲学（照抄上游）：图中心性是导航信号，**不顶替**语义相似度主排序；
 * 命中后交给模型的是**原始 Q/A 原文**，摘要只负责导航。
 *
 * 纯同步逻辑 + 注入式 queryVector，便于离线单测（不依赖 Ollama）。
 */
import { buildBM25, cosine, rrfRank, fuseRoutes } from './text.js'
import { getTriplesForTurn } from './store.js'

const DEFAULT_K = 5
const DEFAULT_POOL = 10
/** 命中轮的实义内容（问＋答，剥掉表情与寒暄后）低于这个字数就不算命中。0 = 关。 */
const DEFAULT_MIN_TURN_CHARS = 20
const DAMPING = 0.85
const PPR_ITERATIONS = 20

/**
 * 路线权重（2026-09-23 实测后定）：BM25 是主力——真实数据上字面命中率最高；
 * 向量抗压缩（摘要越短越重要）；图路线提供"具体实体"导航。
 * 等权融合会把强路线的正确结果挤下去（head12 等权 R@1 60.8% < 纯 BM25 86.1%），
 * 所以按实测配权而非默认 1。
 */
export const ROUTE_WEIGHTS = { bm25: 1, vector: 0.6, graph: 0.8 }

/**
 * 默认融合模式。
 *   gated    —— 词法命中已经够多（≥k）时，**以词法排序为主**，向量/图只补足候选池尾部，
 *               不让向量把词法的头名挤下去；词法不够时才走加权融合。
 *   weighted —— 一律加权 RRF。
 * 2026-09-23 实测：字面派生查询上等权融合 R@1 反而低于纯 BM25（60.8% vs 86.1%），
 * 加权能拉回一点（64.6%）但仍不及纯词法——所以"够用就别掺"才是正确姿势。
 */
export const DEFAULT_FUSION_MODE = 'gated'

/** 召回范围内要排除的已可见轮次（"最近窗口里已经完整看得到的不重复注入"）。 */
export function visibleKey(sessionId, userSeq) {
  return `${sessionId}:${userSeq}`
}

/* ── 查询门控：这句话值不值得去翻历史 ───────────────────────────────── */

/**
 * 寒暄/指令壳词：它们不承载"要查什么"的信息，命中的旧轮次也纯属巧合。
 * 只用于**估算信息量**（不影响真正的检索），所以宁可列宽一点。
 */
const FILLER_WORDS = [
  '继续', '接着', '接上', '开始', '现在', '一下', '已经', '然后', '好的',
  '谢谢', '辛苦', '加油', '可以', '不错', 'ok', '嗯', '哦', '噢', '啊', '呀',
  '吧', '呢', '吗', '啦', '哈', '嘿', '我', '你', '他', '她', '它', '们', '的', '了',
  '是', '在', '有', '就', '都', '也', '还', '又', '去', '来', '这', '那', '不', '没',
  '很', '好', '请', '要', '会', '能', '已', '被', '把', '和', '与', '而', '并',
]

/**
 * 提问里"有信息量"的字数：剥掉表情标记、注入块痕迹、标点空白与寒暄壳词后剩多少字。
 *
 * 依据（2026-09-24 真机第一条旁路记录）：查询「我已重启，继续吧 [表情: …]」把
 * "重启"这个词喂给 BM25，召回 5 轮里 4 轮是旧插件/表情话题——**查询本身没有内容时，
 * 任何排序都只是噪音**。所以先门控，再谈排序。
 */
export function informativeLength(query) {
  let text = String(query ?? '')
  text = text.replace(/\[表情:[^\]]*\]/g, ' ') // [表情: xxx]
  text = text.replace(/【[^】]*】/g, ' ') // 注入块痕迹
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase()
  for (const word of FILLER_WORDS) text = text.split(word).join(' ')
  return text.replace(/\s+/g, '').length
}

/**
 * "这句话依赖历史"的**强信号**：明确指向某段更早的内容。
 *
 * 2026-09-25 补（维护者问"能不能有次级逻辑去翻书架"时发现的真 bug）：
 * 门控本意是挡寒暄，但「上次那个」这类**恰恰最需要翻书架**——
 * 「上次那个继续」剥完只剩 3 个实义字，会被门槛 6 直接挡在门外，
 * 等于把唯一该召回的场景关掉了。所以带强信号的句子**门槛放宽**。
 *
 * ⚠️ 刻意**不收**「继续／接着／接上」：它们单独出现时多半是寒暄式收尾
 * （真机反例「我已重启，继续吧」——2 个实义字、命中 4/5 轮无关），
 * 而跨会话开场说「继续」由 relay 负责，轮次召回这里不需要跟着放行。
 */
const HISTORY_HINTS = [
  '上次', '上一次', '刚才', '之前', '前面', '那个', '那件事', '这件事',
  '说好', '说过', '你记得', '还记得', '回顾', '为什么这么', '为什么这样', '怎么定', '当时的', '原本',
]

/** 这句话是否在依赖历史（指代/追问/接力）。 */
export function hasHistoryHint(query) {
  const t = String(query ?? '').toLowerCase()
  return HISTORY_HINTS.some((word) => t.includes(word))
}

/**
 * 值不值得召回。
 * @param options.minQueryChars 常句门槛（代码默认 4，profile 配置现为 6）
 * @param options.hintMinQueryChars 依赖历史的句子放宽到多低（默认 2）
 */
export function shouldRecall(query, options = {}) {
  const min = Number.isFinite(Number(options.minQueryChars)) ? Number(options.minQueryChars) : 4
  if (min <= 0) return true
  const len = informativeLength(query)
  if (len >= min) return true
  const hintMin = Number.isFinite(Number(options.hintMinQueryChars)) ? Number(options.hintMinQueryChars) : 2
  return hintMin > 0 && len >= hintMin && hasHistoryHint(query)
}

/* ── 回声降权：区分"事件本身"与"后来讨论它的事件" ────────────────────── */

/**
 * 二阶轮（"回声"）的特征：正文在谈论**记忆系统/会话日志本身**，而不是在谈论世界。
 * 这类轮次词法密度往往更高，会盖过真正的一手记录（真机实例：查询"继续吧"的榜首
 * 就是一条"本轮记忆归档完成…新增 0mue1ne0…"）。
 *
 * 判据刻意收窄（宁可不降权，也不误伤正常技术讨论）：
 *  - 记忆条目 id（`0m` + 6 位以上）——几乎只出现在我们的元讨论里；
 *  - 记忆工具名（memory_remember / memory_update / …）；
 *  - 明确的归档/整理动作词；
 *  - 提交号讨论（要与"提交/commit"同现）。
 */
const ECHO_RULES = [
  { label: 'memory-id', factor: 0.5, re: /\b0m[a-z0-9]{6,}/i },
  { label: 'memory-tool', factor: 0.55, re: /memory_(remember|update|search|read|project|graph|semantic)/i },
  { label: 'memory-meta', factor: 0.6, re: /(记忆整理|记忆反思|记忆归档|归档完成|落盘为|新增\s*\d+\s*条记忆|压缩至|dream)/ },
  { label: 'commit-talk', factor: 0.7, re: /(?:commit|提交)\s*`?[0-9a-f]{7,8}/i },
]

/** 返回该轮文本的回声判定：factor<1 表示应按此系数降权。 */
export function detectEcho(text) {
  const t = String(text ?? '')
  let factor = 1
  let label = null
  for (const rule of ECHO_RULES) {
    if (rule.factor < factor && rule.re.test(t)) { factor = rule.factor; label = rule.label }
  }
  return { factor, label }
}

function candidateTurns(db, excludeKeys, sessionId) {
  const rows = db.prepare('SELECT id, session_id, user_seq FROM tm_turns').all()
  // sessionId 支持前缀（工具允许传 12 位短 id）；缺省＝全库
  const list = sessionId ? rows.filter((r) => String(r.session_id).startsWith(String(sessionId))) : rows
  const kept = excludeKeys && excludeKeys.size > 0
    ? list.filter((r) => !excludeKeys.has(visibleKey(String(r.session_id), Number(r.user_seq))))
    : list
  return kept.map((r) => ({ id: String(r.id), sessionId: String(r.session_id), userSeq: Number(r.user_seq) }))
}

/* ── 路线 1：词法（原文索引） ─────────────────────────────────────── */

/**
 * 剥掉**不承载语义的标记**：表情包标记与图片/文件占位符。
 *
 * 真机实证（2026-09-24，注入上线后第二条记录）：查询里带「[表情: 得意闭眼拳头…]」时，
 * Top-5 **全是用过同一表情的轮次**、相关度 57~58；剥掉之后分数掉到 8~10，命中变成
 * 真正与"重启"相关的轮次。原因是表情标记的几十个字符提供了十几个 bigram 匹配，
 * **文字量压倒了真正的内容词**——这是检索污染，索引与查询两侧都必须剥。
 *
 * 为什么不"动态读图库 caption"（维护者 2026-09-24 问过）：匹配的是**标记格式**而不是
 * 具体表情文本——图库增删表情都不影响本函数，也无需耦合 dsh-meme 的数据。
 * 但要跟着**插件的标记协议**走：dsh-meme/client.js 的 `MEME_TEXT_RE` 认两种形态，
 * 除了 `[表情: 描述]` 还有旧格式 `[表情: 描述](url)`，所以 URL 尾巴一并剥掉。
 */
export function stripNonContent(text) {
  return String(text ?? '')
    .replace(/\[表情:[^\]]*\](?:\(https?:\/\/[^\s)]*\))?/g, ' ')
    .replace(/⟨[^⟩]{0,24}⟩/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 词法路线：BM25 建在**原文**上（userText ＋ answerText），**不用摘要**。
 *
 * 依据（2026-09-23 同口径实测）：LLM 摘要会改写措辞，若把 BM25 也建在摘要上，
 * 字面查询 R@1 会掉 66.7%（前 12 字）/ 58.8%（中段片段）；而向量只掉 11~18%。
 * 所以采用**混合索引**：原文喂 BM25（保住"记得具体词/路径"时的精确命中），
 * 摘要喂向量（语义召回）——两路各用自己最有把握的素材。
 *
 * 索引与查询都先过 {@link stripNonContent}（见那里的真机实证）。
 */
export function lexicalRoute(db, query, candidates) {
  if (!query || candidates.length === 0) return []
  const allowed = new Set(candidates.map((c) => c.id))
  const rows = db.prepare('SELECT id, user_text, answer_text FROM tm_turns').all()
    .filter((r) => allowed.has(String(r.id)))
  const docs = rows.map((r) => ({ id: String(r.id), text: stripNonContent(`${r.user_text}\n${r.answer_text}`) }))
  return buildBM25(docs)(stripNonContent(query))
}

/* ── 路线 2：摘要向量 ─────────────────────────────────────────────── */

export function vectorRoute(db, queryVector, candidates) {
  if (!Array.isArray(queryVector) || queryVector.length === 0 || candidates.length === 0) return []
  const allowed = new Set(candidates.map((c) => c.id))
  const rows = db.prepare('SELECT turn_id, embedding FROM tm_vectors').all()
  const scored = []
  for (const row of rows) {
    const id = String(row.turn_id)
    if (!allowed.has(id)) continue
    const vec = blobToFloat(row.embedding)
    if (!vec || vec.length === 0) continue
    scored.push({ id, score: cosine(queryVector, vec) })
  }
  return scored.sort((a, b) => b.score - a.score)
}

function blobToFloat(blob) {
  try {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
    return Float32Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)))
  } catch {
    return null
  }
}

/* ── 路线 3：词项图 + 个性化 PageRank ─────────────────────────────── */

/** 词项图：同一三元组的 subject↔object 相连；词项→轮次 做反向索引。 */
export function buildTermGraph(db) {
  const rows = db.prepare('SELECT turn_id, subject_id, object_id FROM tm_triples').all()
  const adj = new Map()
  const turnsOfTerm = new Map()
  const link = (a, b) => {
    if (a === b) return
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a).add(b)
    adj.get(b).add(a)
  }
  const addTurn = (term, turn) => {
    if (!turnsOfTerm.has(term)) turnsOfTerm.set(term, new Set())
    turnsOfTerm.get(term).add(turn)
  }
  for (const row of rows) {
    const subject = String(row.subject_id)
    const object = String(row.object_id)
    const turn = String(row.turn_id)
    link(subject, object)
    addTurn(subject, turn)
    addTurn(object, turn)
  }
  return { adj, turnsOfTerm }
}

/**
 * 个性化 PageRank：teleport 始终回种子；dangling 按 teleport 分布回收。
 * @param adj Map<id, Set<id>>
 * @param seeds Map<id, weight>
 */
export function personalizedRank(adj, seeds, options = {}) {
  const damping = options.damping ?? DAMPING
  const iterations = options.iterations ?? PPR_ITERATIONS
  const ids = [...adj.keys()]
  if (ids.length === 0 || seeds.size === 0) return new Map()
  const totalWeight = [...seeds.values()].reduce((a, b) => a + b, 0) || 1
  const teleport = new Map([...seeds.entries()].map(([id, w]) => [id, w / totalWeight]))
  let rank = new Map(ids.map((id) => [id, teleport.get(id) ?? 0]))
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Map(ids.map((id) => [id, (1 - damping) * (teleport.get(id) ?? 0)]))
    let dangling = 0
    for (const id of ids) {
      const nbrs = adj.get(id)
      const current = rank.get(id) ?? 0
      if (!nbrs || nbrs.size === 0) {
        dangling += current
        continue
      }
      const share = (damping * current) / nbrs.size
      if (share === 0) continue
      for (const nb of nbrs) next.set(nb, (next.get(nb) ?? 0) + share)
    }
    if (dangling > 0) {
      for (const id of ids) next.set(id, (next.get(id) ?? 0) + damping * dangling * (teleport.get(id) ?? 0))
    }
    rank = next
  }
  return rank
}

/** 查询里的字面词项 → 种子；种子词项所在轮次聚合成图路线分数。 */
export function graphRoute(db, query, candidates, options = {}) {
  const normalized = String(query ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return []
  const allowed = new Set(candidates.map((c) => c.id))
  // 严格词法种子：查询串里直接出现（含）的词项，长词优先
  const terms = db.prepare('SELECT id, normalized FROM tm_terms').all()
    .filter((t) => t.normalized && normalized.includes(String(t.normalized)))
    .sort((a, b) => String(b.normalized).length - String(a.normalized).length)
    .slice(0, options.maxSeeds ?? 12)
  if (terms.length === 0) return []
  const { adj, turnsOfTerm } = options.graph ?? buildTermGraph(db)
  const seeds = new Map()
  terms.forEach((t, index) => seeds.set(String(t.id), 1 / (index + 1)))
  const rank = personalizedRank(adj, seeds, options)
  const byTurn = new Map()
  for (const [termId, score] of rank) {
    for (const turnId of turnsOfTerm.get(termId) ?? []) {
      if (!allowed.has(turnId)) continue
      byTurn.set(turnId, (byTurn.get(turnId) ?? 0) + score)
    }
  }
  return [...byTurn.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}

/* ── 融合 ──────────────────────────────────────────────────────────── */

/**
 * 三路召回 + RRF 融合。
 * @param db 打开的 turns 库
 * @param options.query 查询文本
 * @param options.queryVector 查询向量（可选；缺省则只用词法与图）
 * @param options.k 返回条数
 * @param options.excludeKeys 已可见轮次 key 集合（见 visibleKey）
 */
export function recallTurns(db, options = {}) {
  const query = String(options.query ?? '').trim()
  const k = Math.max(1, Math.min(20, Number(options.k) || DEFAULT_K))
  const pool = Math.max(k, Math.min(50, Number(options.pool) || DEFAULT_POOL))
  // 门控先行：提问本身没有内容时（"继续吧""嗯嗯"），别去翻历史——翻出来的都是巧合。
  if (!shouldRecall(query, options)) {
    return {
      results: [],
      diagnostics: { candidates: 0, engine: 'none', gated: 'query-too-thin', informative: informativeLength(query) },
    }
  }
  const candidates = candidateTurns(db, options.excludeKeys, options.sessionId)
  if (candidates.length === 0) return { results: [], diagnostics: { candidates: 0, engine: 'none' } }

  const graph = options.graph ?? buildTermGraph(db)
  const lexical = lexicalRoute(db, query, candidates)
  const vector = vectorRoute(db, options.queryVector, candidates)
  const graphScores = graphRoute(db, query, candidates, { graph })

  const routeLists = []
  if (lexical.length) routeLists.push({ name: 'bm25', list: lexical })
  if (vector.length) routeLists.push({ name: 'vector', list: vector })
  if (graphScores.length) routeLists.push({ name: 'graph', list: graphScores })
  const merged = fuseRoutes(routeLists, { k, pool, weights: options.weights, mode: options.fusionMode, gateGap: options.gateGap })
  const routeNames = routeLists.map((route) => route.name)

  const detail = db.prepare('SELECT * FROM tm_turns WHERE id=?')
  // 回声**标记始终做**（诊断要能看见），但**降权默认关闭**——2026-09-24 用人工改写查询集
  // 量化后：开启降权 R@1 13.3%→6.7%、MRR 0.224→0.178，**净负面**。
  // 原因很实在：在维护者这里"记忆系统"本身就是一等公民的正题，含记忆 id / 提交号的轮次
  // 常常正是被查询的目标，"谈论记忆 ⇒ 二手"这条内容侧判据站不住。
  // 真正有效的是**查询门控**（见 shouldRecall）；降权保留为显式开关，供将来按查询侧特征使用。
  const useEcho = options.echoPenalty === true
  const flagged = merged.map((hit) => {
    const row = detail.get(hit.id)
    if (!row) return hit
    const echo = detectEcho(`${row.summary}\n${row.user_text}`)
    if (echo.factor >= 1) return hit
    if (!useEcho) return { ...hit, echo: echo.label }
    return { ...hit, echo: echo.label, rawScore: hit.score ?? 0, score: (hit.score ?? 0) * echo.factor }
  })
  const rescored = useEcho ? [...flagged].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : flagged

  // 内容门控：命中轮自身**实义内容太贫瘠**就不算命中。真机实例（2026-09-24）：
  // 查询「重启回来了，现在我该做什么操作协助你验证」召回了"问=答=一个表情"的旧轮——
  // 字面（"重启回来了"）几乎逐字相同，信息量为零。字面相似不等于有用，这是最后一道闸。
  const minTurnChars = Number.isFinite(Number(options.minTurnChars))
    ? Number(options.minTurnChars)
    : DEFAULT_MIN_TURN_CHARS
  const useful = minTurnChars <= 0 ? rescored : rescored.filter((hit) => {
    const row = detail.get(hit.id)
    if (!row) return false
    return informativeLength(row.user_text) + informativeLength(row.answer_text) >= minTurnChars
  })

  const results = useful.slice(0, k).map((hit) => {
    const row = detail.get(hit.id)
    if (!row) return null
    const out = {
      turnId: String(row.id),
      sessionId: String(row.session_id),
      turnIndex: Number(row.turn_index),
      outcome: String(row.outcome),
      summary: String(row.summary),
      userSeq: Number(row.user_seq),
      answerSeq: Number(row.answer_seq),
      userText: String(row.user_text),
      answerText: String(row.answer_text),
      score: Number((hit.score ?? 0).toFixed(6)),
      routes: routeNames.filter((_, i) => Number.isInteger(hit.routes?.[i])),
      triples: getTriplesForTurn(db, hit.id).map((t) => ({ subject: t.subject, predicate: t.predicate, object: t.object })),
    }
    if (hit.echo) { out.echo = hit.echo; out.rawScore = Number((hit.rawScore ?? 0).toFixed(6)) }
    return out
  }).filter(Boolean)

  return {
    results,
    diagnostics: {
      candidates: candidates.length,
      lexical: lexical.length,
      vector: vector.length,
      graph: graphScores.length,
      engine: routeNames.join('+') || 'none',
      fused: merged.length,
      echoPenalized: rescored.filter((h) => h.echo).length,
      thinFiltered: rescored.length - useful.length,
    },
  }
}
