/**
 * dsh-memory-semantic —— meow-memory 语义检索增强层（Host 半侧）
 * 职责：
 *  1. 只读 meow-memory 记忆库（<workspace>/.dsh-meow/memory.db），在其上建本地向量索引；
 *  2. 向量：本地 Ollama (bge-m3, 127.0.0.1:11434) —— 零 API 费、数据不出门；
 *  3. 检索：BM25（字符 bigram + 英文词）+ 向量余弦 → RRF 融合，提供 memory_semantic 工具；
 *  4. 索引文件：<workspace>/.dsh-semantic/vectors.json（条目带 updated_at 做增量 diff）。
 * 设计约束（用户拍板）：
 *  - 不碰 meow-memory 一字节：它是在线市场插件，保持正常更新；合并进上游时将本插件逻辑内嵌即可。
 *  - Ollama 不可达时降级为纯 BM25（仍可用，不报错）。
 * 手写 bundle，无构建步骤；依赖仅 Node 内置 + global fetch。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { loadGraph, buildGraph, graphPathOf } from './graph.js'
import { registerActionTriggers } from './action-trigger.js'
import { registerSessionRelay } from './session-relay.js'
import { registerLiveSink, announce } from './turns/live-sink.js'
import { registerRecallShadow } from './turns/recall-shadow.js'
import { openTurnsDb, turnsDbExists, turnsDbPathOf } from './turns/schema.js'
import { recallTurns } from './turns/recall.js'
import { embedQuery } from './turns/embed.js'
import { normalizeConfig, DEFAULTS } from './config.js'
import { readOverlay, writeOverlay, applyOverlay, overlayFile } from './runtime-overlay.js'
import { probeOllama, ensureOllama } from './ollama.js'
import { createLedger } from './injection-ledger.js'
import { readHostCompaction, scanSessionPeaks, decompressFrames, dshHome } from './host-scan.js'

export const name = 'dsh-memory-semantic'
export const inject = ['tools', 'webServer', 'agents']

const TABLES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

// 所有可调参数集中在 lib/config.js（profile patch 的 config 段可整段覆盖）。
// 这里的 DEFAULT_* 只在"函数被独立直跑"（自测/诊断脚本）时兜底。
const DEFAULT_OLLAMA = DEFAULTS.ollama
const DEFAULT_RETRIEVAL = DEFAULTS.retrieval

// 最近一次见到的工作区：设置页 /state 是 HTTP 请求、没有会话上下文，
// 拿不到 session.header.cwd，只能靠平时顺手记下来兜底。
let recentWorkspace = null
function noteWorkspace(cwd) {
  if (typeof cwd === 'string' && cwd.length > 0) recentWorkspace = cwd
}
function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) { noteWorkspace(cwd); return cwd }
  if (process.env.DSH_WORKSPACE) return process.env.DSH_WORKSPACE
  return null
}
/**
 * 设置页的"当前工作区"解析（2026-10-08 修）：桌面端宿主进程里**没有** DSH_WORKSPACE，
 * 只用环境变量会让 /state 整个返回 workspace=null → 设置页一排 0（数据其实都在）。
 * 顺序：①活着的 agent（与工具侧 workspaceOf 同源，最可信）②宿主环境变量 ③最近见过的 cwd。
 */
function resolveWorkspace(ctx) {
  try {
    const agents = ctx?.agents?.roots?.() ?? ctx?.agents?.list?.() ?? []
    for (const agent of agents) {
      const cwd = agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return { workspace: cwd, source: 'agents' }
    }
  } catch { /* 服务不可用就当没有 */ }
  if (process.env.DSH_WORKSPACE) return { workspace: process.env.DSH_WORKSPACE, source: 'env' }
  if (recentWorkspace) return { workspace: recentWorkspace, source: 'recent' }
  const fromLogs = workspaceFromSessionLogs()
  if (fromLogs) return { workspace: fromLogs, source: 'session-log' }
  return { workspace: null, source: 'none' }
}

/**
 * 兜底：从会话日志推"最近活动的工作区"。
 *
 * 为什么需要它：2026-10-08 实测，桌面端宿主里 /state 拿工作区三级全空
 * （ctx.agents 因未声明 inject 拿不到、env 为空、recentWorkspace 也没记过）→
 * 设置页显示 source=none、索引/轮次/图谱全 0。而**会话日志第一行的 header 里
 * 就有明文 cwd**，读它不依赖任何服务，是最后一道保险。
 * 目录形如 <dshHome>/sessions/<编码工作区>/<session-id>/session.v*.jsonl.zstd。
 * 结果缓存 30 秒，避免每次请求都翻目录。
 */
let wsCache = { at: 0, value: null }
function workspaceFromSessionLogs(home = dshHome()) {
  const now = Date.now()
  if (now - wsCache.at < 30000) return wsCache.value
  let value = null
  try {
    const root = path.join(home, 'sessions')
    let best = null
    for (const wsDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!wsDir.isDirectory()) continue
      const wsPath = path.join(root, wsDir.name)
      let sids = []
      try { sids = fs.readdirSync(wsPath, { withFileTypes: true }) } catch { continue }
      for (const sid of sids) {
        if (!sid.isDirectory()) continue
        const sidPath = path.join(wsPath, sid.name)
        let files = []
        try { files = fs.readdirSync(sidPath) } catch { continue }
        for (const f of files) {
          if (!/^session\.v\d+\.jsonl\.zstd$/.test(f)) continue
          const full = path.join(sidPath, f)
          try {
            const st = fs.statSync(full)
            if (!best || st.mtimeMs > best.mtime) best = { full, mtime: st.mtimeMs, size: st.size }
          } catch { /* 跳过读不到的 */ }
        }
      }
    }
    if (best) {
      const fd = fs.openSync(best.full, 'r')
      const buf = Buffer.alloc(Math.min(262144, best.size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const head = decompressFrames(buf).split('\n')[0] || ''
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)
      if (m) value = JSON.parse('"' + m[1] + '"')
    }
  } catch { /* 兜底失败就算了，绝不能因此让 /state 挂掉 */ }
  wsCache = { at: now, value }
  return value
}

/** 读一个小 JSON 请求体（8KB 上限：这个接口只收白名单里的布尔值）。 */
function readJsonBody(req, limitBytes = 8192) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) { resolve(null); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}
function dbPathOf(workspace) { return path.join(workspace, '.dsh-meow', 'memory.db') }
function vecPathOf(workspace) { return path.join(workspace, '.dsh-semantic', 'vectors.json') }

// ---------- 记忆库读取（只读，动态取共有列） ----------
function readMemories(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const WANT = ['id', 'content', 'title', 'keywords', 'project', 'subcategory', 'status', 'updated_at']
  const rows = []
  for (const t of TABLES) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
      const pick = WANT.filter((c) => cols.includes(c))
      const rs = db.prepare(`SELECT ${pick.join(', ')} FROM ${t} WHERE status != 'archived'`).all()
      for (const r of rs) rows.push({ ...r, level: t })
    } catch (e) { /* 表不存在等：跳过 */ }
  }
  db.close()
  return rows
}

// ---------- 文本与向量工具 ----------
function tokenize(text) {
  const t = String(text || '').toLowerCase()
  const tokens = []
  tokens.push(...(t.match(/[a-z0-9_]+/g) || []))
  const zh = t.replace(/[a-z0-9_\s]+/g, '')
  for (let i = 0; i < zh.length - 1; i++) tokens.push(zh.slice(i, i + 2))
  return tokens
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}
function embedTextOf(row) {
  let t = String(row.content || '').trim()
  if (t.length > 500) t = t.slice(0, 500)
  if (row.keywords) t += '\n关键词: ' + row.keywords
  return t
}

// ---------- Ollama（探测 / 拉起 / 降级的完整策略见 lib/ollama.js）----------
async function ollamaEmbed(inputs, oc = DEFAULT_OLLAMA) {
  const base = String(oc.url || '').replace(/\/+$/, '')
  const r = await fetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: oc.model, input: inputs }),
  })
  if (!r.ok) throw new Error(`embed HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const j = await r.json()
  if (!Array.isArray(j.embeddings)) throw new Error('no embeddings in response')
  return j.embeddings
}
async function embedWithRetry(inputs, oc = DEFAULT_OLLAMA) {
  for (let attempt = 1; ; attempt++) {
    try { return await ollamaEmbed(inputs, oc) }
    catch (e) {
      if (attempt >= 4) throw e
      await new Promise((res) => setTimeout(res, 1200 * attempt))
    }
  }
}
/** 健康探测（保留此名给自测与旧调用点）。 */
async function ollamaHealthy(oc = DEFAULT_OLLAMA) {
  return probeOllama(oc)
}

// ---------- 向量索引（增量 diff） ----------
function loadIndex(workspace) {
  try {
    const vp = vecPathOf(workspace)
    if (!fs.existsSync(vp)) return null
    return JSON.parse(fs.readFileSync(vp, 'utf8'))
  } catch { return null }
}
function saveIndex(workspace, idx) {
  const vp = vecPathOf(workspace)
  fs.mkdirSync(path.dirname(vp), { recursive: true })
  const tmp = vp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(idx), 'utf8')
  fs.renameSync(tmp, vp)
}
async function ensureIndex(workspace, dbFile, logger, cfg) {
  const c = normalizeConfig(cfg) // 允许 undefined（脚本直跑）
  const oc = c.ollama
  const batch = oc.embedBatch
  const rows = readMemories(dbFile)
  let idx = loadIndex(workspace)
  if (!idx || idx.model !== oc.model) idx = { model: oc.model, updated: 0, entries: {} }
  const byId = new Map(rows.map((r) => [r.id, r]))
  const toEmbed = []
  for (const r of rows) {
    const cur = idx.entries[r.id]
    if (!cur || String(cur.updated_at) !== String(r.updated_at ?? 0)) toEmbed.push(r)
  }
  for (const id of Object.keys(idx.entries)) if (!byId.has(id)) delete idx.entries[id]
  let pendingEmbed = 0
  if (toEmbed.length > 0) {
    logger && logger.info(`dsh-memory-semantic: embedding ${toEmbed.length} changed/new entries`)
    for (let i = 0; i < toEmbed.length; i += batch) {
      const slice = toEmbed.slice(i, i + batch)
      let embs = null
      try {
        embs = await embedWithRetry(slice.map(embedTextOf), oc)
      } catch (e) {
        // 降级兜底（2026-10-07 修）：Ollama 缺席时只跳过"向量补嵌"，
        // 保留已有向量并让纯 BM25 照常检索 —— 绝不让 memory_semantic 整体失败。
        // 已完成的批次照常落盘，下次调用时再从这个断点续补。
        pendingEmbed = toEmbed.length - i
        logger && logger.warn && logger.warn(
          `dsh-memory-semantic: 向量补嵌失败，已降级（跳过 ${pendingEmbed} 条，检索仍走 BM25）：${(e && e.message) || e}`,
        )
        break
      }
      slice.forEach((r, k) => {
        idx.entries[r.id] = {
          updated_at: r.updated_at ?? 0,
          level: r.level, project: r.project || '', subcategory: r.subcategory || '',
          keywords: r.keywords || '',
          content: String(r.content || '').slice(0, c.retrieval.outputChars * 3),
          vector: embs[k],
        }
      })
    }
    if (pendingEmbed === 0) idx.updated = Date.now()
    saveIndex(workspace, idx)
  }
  return { idx, rows, pendingEmbed }
}

// ---------- BM25（轻量，token=字符 bigram + 英数词） ----------
function buildBM25(docs) {
  const N = docs.length
  const tfs = []
  const df = new Map()
  let totalLen = 0
  for (const d of docs) {
    const toks = tokenize(d.text)
    const m = new Map()
    for (const t of toks) m.set(t, (m.get(t) || 0) + 1)
    totalLen += toks.length
    for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1)
    tfs.push({ id: d.id, m, len: toks.length })
  }
  const avgdl = totalLen / Math.max(N, 1) || 1
  const k1 = 1.5, b2 = 0.75
  return function score(query) {
    const qTokens = [...new Set(tokenize(query))]
    const out = []
    for (const d of tfs) {
      let s = 0
      for (const tok of qTokens) {
        const f = d.m.get(tok)
        if (!f) continue
        const idf = Math.log(1 + (N - (df.get(tok) || 0) + 0.5) / ((df.get(tok) || 0) + 0.5))
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b2 + b2 * d.len / avgdl))
      }
      if (s > 0) out.push({ id: d.id, score: s })
    }
    return out.sort((a, b) => b.score - a.score)
  }
}

function rrfRank(listA, listB, pool, k = DEFAULT_RETRIEVAL.rrfK) {
  const ranks = new Map()
  const pushRank = (list, isVec) => {
    for (let i = 0; i < Math.min(list.length, pool); i++) {
      const id = list[i].id
      const cur = ranks.get(id) || { rrf: 0, vectorRank: Infinity, bm25Rank: Infinity }
      if (isVec && i < cur.vectorRank) cur.vectorRank = i
      if (!isVec && i < cur.bm25Rank) cur.bm25Rank = i
      cur.rrf += 1 / (k + i + 1)
      ranks.set(id, cur)
    }
  }
  pushRank(listA, true)
  pushRank(listB, false)
  return [...ranks.entries()].map(([id, r]) => ({ id, ...r })).sort((a, b) => b.rrf - a.rrf)
}

// ---------- 检索 ----------
async function searchMemory(semanticCtx, args, logger) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('memory_semantic: query 不能为空')
  const k = Math.max(1, Math.min(10, Number(args.k) || 5))
  const mode = ['auto', 'vector', 'bm25'].includes(args.mode) ? args.mode : 'auto'
  const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null
  const days = Number(args.days) > 0 ? Number(args.days) : null
  const cfg = semanticCtx.cfg || normalizeConfig()
  const rc = cfg.retrieval
  const oc = cfg.ollama
  const { idx, rows } = semanticCtx.index
  const entries = idx.entries

  const passes = (r) => {
    if (project && !String(r.project || '').split(',').some((p) => p.trim() === project)) return false
    if (days && r.updated_at && Date.now() - Number(r.updated_at) > days * 864e5) return false
    return true
  }
  const eligibleRows = rows.filter(passes)
  const eligible = new Set(eligibleRows.map((r) => r.id))

  let vecScored = null // [{id, score}]
  let bmScored = null
  if ((mode === 'auto' || mode === 'vector') && semanticCtx.ollamaOk) {
    const qv = (await embedWithRetry([rc.queryInstruction + query], oc))[0]
    vecScored = eligibleRows
      .map((r) => ({ id: r.id, score: cosine(qv, entries[r.id]?.vector || []) }))
      .sort((a, b) => b.score - a.score)
  }
  if (mode === 'auto' || mode === 'bm25') {
    const docs = eligibleRows.map((r) => ({ id: r.id, text: (r.content || '') + ' ' + (r.keywords || '') }))
    bmScored = buildBM25(docs)(query).filter((x) => eligible.has(x.id))
  }

  let merged
  if (vecScored && bmScored) merged = rrfRank(vecScored, bmScored, rc.rrfPool, rc.rrfK)
  else if (vecScored) merged = vecScored.slice(0, rc.rrfPool).map((s, i) => ({ id: s.id, rrf: s.score, vectorRank: i, bm25Rank: Infinity }))
  else if (bmScored) merged = bmScored.slice(0, rc.rrfPool).map((s, i) => ({ id: s.id, rrf: s.score, vectorRank: Infinity, bm25Rank: i }))
  else merged = []
  merged = merged.slice(0, k)

  const g = semanticCtx.graph || null
  const results = merged.map((m) => {
    const e = entries[m.id]
    const gn = g && g.nodes ? g.nodes[m.id] : null
    const out = {
      id: m.id,
      level: e?.level || '',
      project: e?.project || '',
      relevance: Number((m.rrf || 0).toFixed(4)),
      method: m.vectorRank < Infinity && m.bm25Rank < Infinity ? 'fusion'
        : m.vectorRank < Infinity ? 'vector' : 'bm25',
      content: String(e?.content || '').slice(0, rc.outputChars),
      keywords: String(e?.keywords || '').slice(0, 160),
    }
    if (gn) out.graph = { pr: gn.pr, community: gn.community }
    return out
  })

  const engine = [vecScored && 'vector', bmScored && 'bm25'].filter(Boolean).join('+') || 'none'
  const degraded = !semanticCtx.ollamaOk && (mode === 'auto' || mode === 'vector')
  const pendingEmbed = Number(semanticCtx.pendingEmbed) || 0
  const pendingNote = pendingEmbed > 0 ? `；另有 ${pendingEmbed} 条新记忆待补向量（Ollama 恢复后自动补）` : ''
  return {
    ok: true,
    engine,
    indexed: Object.keys(entries).length,
    degraded,
    results,
    note: degraded
      ? 'Ollama 不可达，已降级为 BM25（运行 ollama pull ' + oc.model + ' 恢复向量检索）' + pendingNote
      : `向量引擎 ${oc.model} 可用` + pendingNote,
  }
}

function toolDefinition(semanticCtx, logger) {
  return {
    name: 'memory_semantic',
    description: '语义检索跨会话记忆（meow-memory 向量增强层）：BM25 关键词 + 本地向量（bge-m3）融合，比单纯记忆库检索更懂语义换词（如「记得他」→「记得我」）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索问题/关键词（用语义化的自然说法，无需与原记忆关键词一致）' },
        k: { type: 'integer', default: 5, description: '返回条数（1-10，默认 5）' },
        mode: { type: 'string', enum: ['auto', 'vector', 'bm25'], default: 'auto', description: 'auto=向量+BM25 融合（默认）；vector=仅向量；bm25=仅关键词' },
        project: { type: 'string', description: '按项目过滤（如 dsh / my-project）' },
        days: { type: 'integer', description: '只看最近 N 天内更新的记忆' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'results'],
        properties: {
          ok: { type: 'boolean' }, engine: { type: 'string' }, indexed: { type: 'integer' },
          degraded: { type: 'boolean' }, note: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['id', 'content'],
              properties: {
                id: { type: 'string' }, level: { type: 'string' }, project: { type: 'string' },
                relevance: { type: 'number' }, method: { type: 'string' },
                content: { type: 'string' }, keywords: { type: 'string' },
                graph: { type: 'object', additionalProperties: false, properties: { pr: { type: 'number' }, community: { type: 'string' } } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value
        const lines = []
        lines.push(v.degraded ? `⚠️ ${v.note}` : `🔎 语义检索（${v.engine}，库内 ${v.indexed} 条）—— ${v.note}`)
        const rs = Array.isArray(v.results) ? v.results : []
        if (rs.length === 0) lines.push('未命中。')
        rs.forEach((r, i) => lines.push(`#${i + 1} [${r.relevance}] (${r.level}/${r.project || '-'}/${r.method}) ${r.content}`))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_semantic: 无法确定工作区（会话无 cwd）')
      try {
        const dbFile = dbPathOf(workspace)
        if (!fs.existsSync(dbFile)) throw new Error('记忆库不存在: ' + dbFile)
        const synced = await ensureIndex(workspace, dbFile, logger, semanticCtx.cfg) // 每次都增量 diff：新记忆自动入向量索引
        semanticCtx.index = synced
        semanticCtx.pendingEmbed = synced.pendingEmbed || 0
      } catch (e) { throw new Error('memory_semantic: 索引失败: ' + (e && e.message || e)) }
      semanticCtx.graph = loadGraph(workspace)
      // 探测 →（autoStart=true 时）后台点火：**不阻塞本次调用**，本次照常走 BM25。
      if (!semanticCtx.ollamaOk) {
        const st = await ensureOllama(semanticCtx.cfg.ollama, logger)
        semanticCtx.ollamaOk = st.ok
        semanticCtx.ollamaState = st
      }
      return await searchMemory(semanticCtx, args, logger)
    },
  }
}

// ---------- memory_graph 工具 ----------
function graphToolDefinition(semanticCtx, logger) {
  return {
    name: 'memory_graph',
    description: '记忆图谱实用工具（知识图谱二期·离线构建的相似图）：查看记忆的客观重要性（全局 PageRank）、知识域（社区聚类）与相似邻居。stats=全局统计+TOP 重要性；neighbors=某条记忆的相似邻居；community=同知识域成员；rebuild=图谱过期/新增大量记忆后重建（慢，索引增量）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['stats', 'neighbors', 'community', 'rebuild'], description: '操作类型' },
        id: { type: 'string', description: '记忆条目 id（neighbors/community 必填）' },
        limit: { type: 'integer', default: 8, description: '返回条数（1-20，默认 8）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          note: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, level: { type: 'string' }, project: { type: 'string' },
                content: { type: 'string' }, score: { type: 'number' }, weight: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value
        const lines = []
        lines.push(`🧠 记忆图谱（${v.action}）${v.note ? ' — ' + v.note : ''}`)
        const rs = Array.isArray(v.items) ? v.items : []
        if (rs.length === 0) lines.push('（无条目）')
        rs.forEach((r, i) => {
          const k = r.score ?? r.weight ?? '-'
          lines.push(`#${i + 1} [${k}] (${r.level || '-'}/${r.project || '-'}) ${String(r.content || '').slice(0, 60)}`)
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_graph: 无法确定工作区（会话无 cwd）')
      const dbFile = dbPathOf(workspace)
      if (!fs.existsSync(dbFile)) throw new Error('记忆库不存在: ' + dbFile)
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
      const action = args.action
      const snippet = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 60)
      const fmtItem = (id, extra) => {
        const r = (rowsById.get(id) || {})
        return { id, level: r.level || '', project: r.project || '', content: snippet(r.content), ...extra }
      }
      // rebuild：重建图谱（增量向量化）
      if (action === 'rebuild') {
        const { summary } = await buildGraph(workspace, dbFile, logger, { cfg: semanticCtx.cfg })
        const rowsAll = readMemories(dbFile)
        const m = new Map(rowsAll.map((r) => [r.id, r]))
        return {
          ok: true, action,
          note: `已重建：节点 ${summary.nodeCount} / 边 ${summary.edgeCount} / 社区 ${summary.communityCount}（缺向量 ${summary.missingVectors}）`,
          items: summary.topPr.slice(0, limit).map((r) => ({ id: r.id, level: m.get(r.id)?.level || '', project: m.get(r.id)?.project || '', content: snippet(m.get(r.id)?.content), score: r.score })),
        }
      }
      // 常规查询：读图 + 条目
      const graph = loadGraph(workspace)
      if (!graph) {
        return { ok: true, action, note: '图谱尚未构建：先跑 node scripts/build-graph.mjs，或使用 action=rebuild', items: [] }
      }
      const rowsById = new Map(readMemories(dbFile).map((r) => [r.id, r]))
      if (action === 'stats') {
        const topPr = Object.entries(graph.nodes || {})
          .map(([id, n]) => ({ id, pr: n.pr, community: n.community }))
          .sort((a, b) => b.pr - a.pr).slice(0, limit)
        return {
          ok: true, action,
          note: `节点 ${graph.nodeCount} / 边 ${graph.edgeCount} / 社区 ${Object.keys(graph.communities || {}).length}（建图于 ${new Date(graph.builtAt).toISOString()}，阈值 ${graph.threshold}）`,
          items: topPr.map((x) => fmtItem(x.id, { score: x.pr })),
        }
      }
      if (action === 'neighbors') {
        if (!args.id) throw new Error('memory_graph neighbors: 需要 id')
        const nbrs = (graph.edges || [])
          .filter(([a, b]) => a === args.id || b === args.id)
          .map(([a, b, w]) => ({ id: a === args.id ? b : a, w }))
          .sort((x, y) => y.w - x.w).slice(0, limit)
        return {
          ok: true, action,
          note: `「${snippet(rowsById.get(args.id)?.content)}」的相似邻居（余弦）`,
          items: nbrs.map((x) => fmtItem(x.id, { weight: Number(x.w.toFixed(3)) })),
        }
      }
      if (action === 'community') {
        if (!args.id) throw new Error('memory_graph community: 需要 id')
        const node = graph.nodes[args.id]
        if (!node) return { ok: true, action, note: '该 id 不在图中（可能已归档）', items: [] }
        const members = (graph.communities[node.community] || [])
          .map((mid) => ({ id: mid, pr: graph.nodes[mid]?.pr || 0 }))
          .sort((a, b) => b.pr - a.pr).slice(0, limit)
        return {
          ok: true, action,
          note: `「${snippet(rowsById.get(args.id)?.content)}」属于 ${node.community}（按图谱重要性排序）`,
          items: members.map((x) => fmtItem(x.id, { score: Number(x.pr.toFixed(4)) })),
        }
      }
      return { ok: false, action, note: '未知 action（可选 stats/neighbors/community/rebuild）', items: [] }
    },
  }
}

// ---------- recall_turns 工具：亲手翻"第二个书架"（对话原文） ----------
/**
 * 与 memory_semantic / memory_search 的分工（维护者 2026-09-25 定）：
 *   那两把是"查我提炼过的笔记"（书架 A·知识层），这一把是"翻对话原文"（书架 B·轮次库）。
 * 什么时候用它：①要引用原话、复现细节 ②察觉某段历史不在眼前（被折叠/在别的会话）
 * ③遇到指代词（"上次那个""继续"）需要落实。它就是折叠之后的"次级逻辑"——
 * 归档标记（书签）写明怎么取，这把工具就是"取书的那只手"。
 *
 * 与自动召回的区别：召回是**系统**在每轮请求前自动塞（被动、按门槛走）；
 * 这把工具是**我自己**判断缺东西时主动调（主动、不设门槛——主动查就是有明确意图）。
 */
function recallTurnsToolDefinition(semanticCtx, logger) {
  const CLIP_USER = 700
  const CLIP_ANSWER = 1100
  const clipText = (text, max) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim()
    return t.length > max ? `${t.slice(0, max)}…` : t
  }
  return {
    name: 'recall_turns',
    description: '检索**对话原文**（轮次记忆库）：按问题找回更早对话的逐字问答。与 memory_search / memory_semantic 分工不同——那两个查"我提炼过的记忆条目"，这个查"当初具体怎么说的"。需要引用原话、复现细节、或察觉某段历史不在眼前（被折叠、或在别的会话）时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '要找回什么（用自然语言描述，如「折叠窗口取多少轮」）' },
        k: { type: 'integer', default: 5, description: '返回条数（1-10，默认 5）' },
        session: { type: 'string', description: '可选：限定会话。"self" = 本会话；也可给会话 id 前缀。缺省＝全库' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'results'],
        properties: {
          ok: { type: 'boolean' },
          note: { type: 'string' },
          indexed: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['turnId', 'sessionId'],
              properties: {
                turnId: { type: 'string' },
                sessionId: { type: 'string' },
                turnIndex: { type: 'integer' },
                score: { type: 'number' },
                routes: { type: 'array', items: { type: 'string' } },
                userText: { type: 'string' },
                answerText: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value
        const lines = [`📚 轮次原文检索 —— ${v.note || ''}`]
        const rs = Array.isArray(v.results) ? v.results : []
        if (rs.length === 0) {
          lines.push('未命中。可以换更具体的说法，或把 session 留空搜全库。')
        }
        rs.forEach((r, i) => {
          lines.push('')
          lines.push(`[${i + 1}] ${r.sessionId} #${r.turnIndex}（相关度 ${r.score}｜${(r.routes || []).join('+') || '-'}）`)
          lines.push(`  问：${r.userText}`)
          lines.push(`  答：${r.answerText}`)
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('recall_turns: 无法确定工作区（会话无 cwd）')
      const query = String(args.query || '').trim()
      if (!query) throw new Error('recall_turns: query 不能为空')
      if (!turnsDbExists(workspace)) {
        return { ok: true, indexed: 0, note: `轮次库还不存在（${turnsDbPathOf(workspace)}）`, results: [] }
      }
      const k = Math.max(1, Math.min(10, Number(args.k) || 5))
      const rawSession = typeof args.session === 'string' ? args.session.trim() : ''
      const sessionId = rawSession === 'self'
        ? String(exec?.agent?.session?.header?.id ?? '')
        : (rawSession || null)
      const db = openTurnsDb(workspace, { readOnly: true })
      try {
        const indexed = Number(db.prepare('SELECT COUNT(*) AS n FROM tm_turns').get()?.n ?? 0)
        let queryVector = null
        try { queryVector = await embedQuery(query) } catch { queryVector = null }
        // 主动查**不设门槛**（门控是给自动注入省 token 用的；主动查就是有明确意图）
        const { results, diagnostics } = recallTurns(db, {
          query, queryVector, k, sessionId: sessionId || undefined, minQueryChars: 0, minTurnChars: 0,
        })
        const scope = sessionId ? `限定会话 ${String(sessionId).slice(0, 16)}` : '全库'
        return {
          ok: true,
          indexed,
          note: `「${clipText(query, 40)}」｜候选 ${diagnostics.candidates}｜引擎 ${diagnostics.engine}｜${scope}`,
          results: results.map((r) => ({
            turnId: r.turnId,
            sessionId: String(r.sessionId).slice(0, 24),
            turnIndex: r.turnIndex,
            score: r.score,
            routes: r.routes,
            summary: clipText(r.summary, 120),
            userText: clipText(r.userText, CLIP_USER),
            answerText: clipText(r.answerText, CLIP_ANSWER),
          })),
        }
      } finally {
        try { db.close() } catch { /* 已关 */ }
      }
    },
  }
}

// ---------- host 入口 ----------
// 核心函数导出：便于独立自测（node 直跑）与将来合并进 meow-memory 时复用
export { ensureIndex, searchMemory, buildBM25, rrfRank, readMemories, tokenize, cosine, ollamaHealthy, vecPathOf }
export { loadGraph, buildGraph, graphPathOf, personalizedPageRank, GRAPH_PARAMS } from './graph.js'
export function apply(ctx, config) {
  const logger = ctx.logger
  const cfg = normalizeConfig(config)
  // 设置页写的运行时覆盖（白名单键，见 runtime-overlay.js）：
  // 优先级 覆盖文件 ＞ profile config ＞ 内置默认，改完即时生效、不碰宿主。
  applyOverlay(cfg, readOverlay())
  const semanticCtx = { index: null, ollamaOk: false, cfg }
  // 注入去重登记表（2026-10-07）：会话级，记"这条记忆已经出现在这个会话里了"。
  // recall-shadow 在每轮 pre-step 扫上下文（含 meow-memory 注入的块）登记，
  // action-trigger 注入前过滤 —— 两个注入点就不会打架。
  const ledger = createLedger()
  ctx.effect(() => () => ledger.dispose(), 'dsh-memory-semantic: injection ledger')

  ctx.effect(
    () => ctx.tools.register(graphToolDefinition(semanticCtx, logger)),
    'dsh-memory-semantic: memory_graph tool',
  )
  ctx.effect(
    () => ctx.tools.register(toolDefinition(semanticCtx, logger)),
    'dsh-memory-semantic: memory_semantic tool',
  )
  // 书架 B（对话原文）的取书工具：主动检索轮次库，返回逐字问答
  ctx.effect(
    () => ctx.tools.register(recallTurnsToolDefinition(semanticCtx, logger)),
    'dsh-memory-semantic: recall_turns tool',
  )
  announce(logger, 'tools registered (memory_semantic, memory_graph, recall_turns)')

  // 动作触发记忆注入（机制层）：关键工具调用结束后，按规则检索红线/教训并附加到下一次模型请求。
  // 依赖由这里注入，避免与 lib/index.js 形成循环 import。
  registerActionTriggers(ctx, { logger, config, readMemories, buildBM25, dbPathOf, ledger })

  // 跨会话接力（机制层 v1，2026-09-19 维护者拍板）：新会话说「继续」时，
  // 自动把**上一个会话的尾巴**接进来 —— 他切会话是为省缓存 token + 保持结构清晰，
  // 期望新会话自动接上而不是手打上下文。落点 agent/pre-step（与 meow-memory 的
  // snapshot 注入同一范式：把 plugin 消息插到最后一条用户消息之前），fail-open。
  // 为什么不做"交接卡"：卡片要有人写（靠自觉），而"上个会话的尾巴"本身就能从
  // 会话日志抽出来 —— 零维护成本、零自觉依赖，覆盖面还更大。
  registerSessionRelay(ctx, { logger, config })

  // ⑥ 异步写入链接线（阶段一最后一根线，2026-09-24）：一轮结束（session/event 里的
  // turn/end）后，把这一轮投影出来 → 调一次抽取模型 → 写进 `<workspace>/.dsh-semantic/turns.db`。
  // 在这之前轮次库只由离线回填脚本写入；接上这条线，轮次记忆才开始随真实对话自己长。
  // fail-open：任何失败都只隔离该轮（回填脚本兜底），绝不影响前台对话；
  // 只写我们自己的库，不碰 DSH 数据、不碰 meow-memory。
  registerLiveSink(ctx, { logger, config })

  // ③ 上下文组装接线（2026-09-24）：每一轮请求模型前（agent/pre-step），拿本轮提问去
  // 轮次库召回更早的历史原文，**先只旁路记录**到 `<workspace>/.dsh-semantic/recall-shadow.jsonl`，
  // 确认命中准、不灌水、不和 relay / meow-memory 打架之后再打开注入
  // （配置 `turns.recallShadow.inject=true`，不用改代码）。
  // 真正的"接管"（折叠模型可见的历史表面）是阶段二，另开授权。
  registerRecallShadow(ctx, { logger, config, ledger })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/memory-semantic',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const sub = url.pathname.replace(/^\/memory-semantic/, '') || '/'
          // ── 设置页数据源（只读）：引擎状态 / 索引 / 轮次库 / 图谱 / 当前配置 / 宿主压缩建议 ──
          if (sub === '/state' && (req.method || 'GET') === 'GET') {
            const { workspace, source: workspaceSource } = resolveWorkspace(ctx)
            const state = {
              ok: true,
              workspace,
              workspaceSource,
              ollama: {
                url: cfg.ollama.url,
                model: cfg.ollama.model,
                autoStart: cfg.ollama.autoStart,
                probeTimeoutMs: cfg.ollama.probeTimeoutMs,
                warmupWaitMs: cfg.ollama.warmupWaitMs,
                healthy: false,
              },
              index: { entries: 0, updated: null, pendingEmbed: Number(semanticCtx.pendingEmbed) || 0, db: null },
              turns: { total: 0, sessions: 0 },
              graph: null,
              config: cfg,
              compaction: readHostCompaction(),
            }
            state.ollama.healthy = await probeOllama(cfg.ollama)
            if (workspace) {
              const dbFile = dbPathOf(workspace)
              if (fs.existsSync(dbFile)) {
                state.index.db = dbFile
                const idx = loadIndex(workspace)
                if (idx) { state.index.entries = Object.keys(idx.entries || {}).length; state.index.updated = idx.updated || null }
              }
              if (turnsDbExists(workspace)) {
                try {
                  const db = openTurnsDb(workspace, { readOnly: true })
                  state.turns.total = Number(db.prepare('SELECT COUNT(*) AS n FROM tm_turns').get()?.n ?? 0)
                  state.turns.sessions = Number(db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM tm_turns').get()?.n ?? 0)
                  db.close()
                } catch { /* 库正忙就跳过 */ }
              }
              const g = loadGraph(workspace)
              if (g) {
                state.graph = {
                  nodeCount: g.nodeCount,
                  edgeCount: g.edgeCount,
                  communities: Object.keys(g.communities || {}).length,
                  threshold: g.threshold,
                  builtAt: g.builtAt,
                }
              }
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(state))
            return
          }
          // ── 写入运行时开关（设置页唯一能动手的地方；白名单见 runtime-overlay.js）──
          if (sub === '/config' && (req.method || 'GET') === 'POST') {
            const body = await readJsonBody(req)
            const r = writeOverlay(body)
            if (r.ok) applyOverlay(cfg, r.overlay)
            res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(r.ok
              ? { ok: true, applied: r.value, file: overlayFile(), ollama: { autoStart: cfg.ollama.autoStart } }
              : { ok: false, errors: r.errors }))
            return
          }
          // ── 会话 token 峰值（按需触发；要解压几个会话，会花几秒）──
          if (sub === '/peaks' && (req.method || 'GET') === 'GET') {
            const peak = scanSessionPeaks({ limit: Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 5)) })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, ...peak }))
            return
          }
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'not-found' }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
        }
      },
    }),
    'dsh-memory-semantic: /memory-semantic routes',
  )
}
