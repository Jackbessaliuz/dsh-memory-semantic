/**
 * align —— 记忆编辑史 → 轮次坐标（source-backed 强定位）
 *
 * ## 为什么需要这一层
 *
 * meow-memory 0.33.0 起给每条记忆写 `editHistory_infoFrom`（编辑史），格式：
 *   「场景-动作-会话短id-turn(n)」或「场景-动作-会话短id-turnRange(a,b)」；事件之间 `; ` 分隔。
 * 有了它，记忆第一次能回答"我从哪句话来的"。但**那个 n 不能直接用**：
 *
 *   n 是 DSH 的**绝对 turn 序号**——数的是会话事件流里的 `turn/start`，其中包括
 *   "插件注入把 agent 从空闲唤醒"的续轮。实测某会话：32 个 turn/start，真用户轮只有 17 个
 *   （15 个是 meow-memory 的 snapshot / perception 的 notice 唤醒的续轮）。
 *
 * 而本插件的 `tm_turns.turn_index` 数的是**真实用户轮**（`source.kind === 'user'`），
 * 两者口径不同，直接拿 n 去查库会**指错地方**（错位随会话里续轮数量漂移，不是固定偏移）。
 *
 * ## 桥
 *
 *   绝对轮 n  →  该轮组内首个 `source.kind === 'user'` 的用户消息 `seq`
 *             →  `tm_turns(session_id, user_seq)`  →  `turn_index` + 原文
 *
 * 实测：日志 `seq` 与 `tm_turns.user_seq` 一致率 17/17，可据此精确到轮。
 *
 * ## 纯读
 *
 * 只读会话日志，不写任何 DSH 数据。对齐结果按日志 `mtimeMs + size` 缓存在
 * `<workspace>/.dsh-semantic/align-cache.json`，会话增长（mtime 变）时自动重建。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, readSessionEvents } from './session-log.js'
import { splitInjected, textOfBlocks } from './project.js'

/** 缓存结构版本：改了分组口径就升它，老缓存自动作废。 */
export const CACHE_VERSION = 2
/** 引用原话长度上限（证据卡是导航，不是内容）。 */
export const QUOTE_MAX = 48
/** 缓存最多留几个会话（超出按最久未用淘汰）。 */
const MAX_CACHED_SESSIONS = 200

const EVENT_RE = /^([a-z][a-z0-9]*)-([a-z][a-z0-9]*)-([0-9a-z]{4,64})-(turn\((\d+)\)|turnRange\((\d+),(\d+)\))$/

export const SCENE_LABEL = { jot: '随手记', reflect: '反思', dream: '整理' }
export const ACTION_LABEL = { remember: '写入', update: '更新', archive: '归档', stale: '完结' }

/**
 * 解析编辑史字符串。
 * @param {string} raw 例如 `jot-update-28a7537f-turn(31); dream-update-28a7537f-turnRange(30,32)`
 * @returns {Array<{raw,scenario,action,shortSession,turn,turnRange,素材轮?}>}
 *   - 单轮事件：`turn = n`
 *   - 区间事件：`turnRange = [a,b]`，语义是"第 b 轮（整理/反思的处理轮）处理了素材第 a..b-1 轮"
 *     → 证据卡指向**素材轮**，因为处理轮往往正是插件唤醒的续轮（没有用户原话）
 */
export function parseEditHistory(raw) {
  const out = []
  const s = String(raw ?? '').trim()
  if (!s) return out
  for (const chunk of s.split(';')) {
    const ev = chunk.trim()
    if (!ev) continue
    const m = EVENT_RE.exec(ev)
    if (!m) {
      out.push({ raw: ev, unparsed: true })
      continue
    }
    const isRange = m[4].startsWith('turnRange')
    out.push({
      raw: ev,
      scenario: m[1],
      action: m[2],
      shortSession: m[3],
      turn: isRange ? Number(m[7]) : Number(m[5]),
      turnRange: isRange ? [Number(m[6]), Number(m[7])] : null,
    })
  }
  return out
}

/**
 * 按短 id 找会话日志：目录名形如 `session-<短id><uuid 其余>`。
 * @returns {string|null} 日志文件绝对路径
 */
export function findSessionLogByPrefix(shortId, home = dshHome()) {
  const sid = String(shortId || '').trim()
  if (!sid) return null
  const root = path.join(home, 'sessions')
  let buckets = []
  try { buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return null }
  const want = sid.startsWith('session-') ? sid : 'session-' + sid
  for (const bucket of buckets) {
    const dir = path.join(root, bucket.name)
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith(want)) continue
      const base = path.join(dir, ent.name)
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        const p = path.join(base, name)
        if (fs.existsSync(p)) return p
      }
    }
  }
  return null
}

/**
 * 把一段会话事件流投影成"绝对轮 → 该轮的首个真实用户轮"。
 *
 * 不数 turn/end、不数 step：只认 turn/start 分组 + 组内首个 `source.kind==='user'`。
 * 这与 {@link ./project.js} 的轮口径一致（那边的 turn_index 就是这么编的）。
 */
export function buildGroups(events) {
  const groups = []
  let cur = null
  for (const e of events) {
    if (e?.type === 'turn/start') {
      cur = { abs: groups.length + 1, userSeq: null, quote: '' }
      groups.push(cur)
      continue
    }
    if (!cur || cur.userSeq !== null) continue
    if (e?.type !== 'user/message' || e?.data?.source?.kind !== 'user') continue
    // 头部的注入块要剥掉：早期 meow-memory 会把注入内容写进真实用户消息的 content 头部
    const { real } = splitInjected(e.data?.content)
    const text = textOfBlocks(real).replace(/\s+/g, ' ').trim()
    if (!text) continue
    cur.userSeq = Number.isInteger(e.seq) ? Number(e.seq) : null
    cur.quote = text.slice(0, QUOTE_MAX)
  }
  return groups
}

/** 读一份日志并投影（不碰缓存）。 */
export function buildAlignmentFromLog(logFile) {
  const { header, events, seqContiguous } = readSessionEvents(logFile)
  const stat = fs.statSync(logFile)
  const groups = buildGroups(events)
  return {
    logFile,
    fullSessionId: typeof header?.id === 'string' && header.id ? header.id : null,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    eventCount: events.length,
    seqContiguous,
    groups,
    realTurns: groups.filter((g) => g.userSeq !== null).length,
  }
}

// ---------- 缓存 ----------

function cachePathOf(workspace) {
  return path.join(workspace, '.dsh-semantic', 'align-cache.json')
}

function loadCache(workspace) {
  const p = cachePathOf(workspace)
  const empty = { version: CACHE_VERSION, sessions: {} }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!j || j.version !== CACHE_VERSION || typeof j.sessions !== 'object') return empty
    return j
  } catch { return empty }
}

function saveCache(workspace, cache) {
  const p = cachePathOf(workspace)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const keys = Object.keys(cache.sessions)
    if (keys.length > MAX_CACHED_SESSIONS) {
      keys
        .sort((a, b) => Number(cache.sessions[a].usedAt || 0) - Number(cache.sessions[b].usedAt || 0))
        .slice(0, keys.length - MAX_CACHED_SESSIONS)
        .forEach((k) => { delete cache.sessions[k] })
    }
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cache))
    fs.renameSync(tmp, p)
  } catch { /* 缓存失败绝不阻塞检索 */ }
}

/**
 * 批量对齐若干"会话短 id"（同一会话只算一次）。
 *
 * @param {string[]} shortIds meow 编辑史里出现的短 id
 * @param {{workspace:string, home?:string, logger?:object, refresh?:boolean}} options
 * @returns {Map<string, {fullSessionId, groups, realTurns, cached:boolean}|null>}
 *   找不到会话日志（会话被删/短 id 碰撞无匹配）时为 null
 */
export function alignForSessions(shortIds, options = {}) {
  const out = new Map()
  const list = [...new Set((Array.isArray(shortIds) ? shortIds : []).map((s) => String(s || '').trim()).filter(Boolean))]
  if (list.length === 0) return out
  const workspace = options.workspace
  const home = options.home || dshHome()
  const cache = workspace ? loadCache(workspace) : { version: CACHE_VERSION, sessions: {} }
  let dirty = false
  const now = Date.now()

  for (const shortId of list) {
    const logFile = findSessionLogByPrefix(shortId, home)
    if (!logFile) { out.set(shortId, null); continue }
    let stat = null
    try { stat = fs.statSync(logFile) } catch { out.set(shortId, null); continue }

    const cached = cache.sessions[shortId]
    if (!options.refresh && cached && cached.logFile === logFile && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.usedAt = now
      dirty = true
      out.set(shortId, { fullSessionId: cached.fullSessionId, groups: cached.groups, realTurns: cached.realTurns, cached: true })
      continue
    }

    let built = null
    try { built = buildAlignmentFromLog(logFile) } catch (e) {
      options.logger?.warn?.(`dsh-memory-semantic: 轮次对齐失败（${shortId}）：${(e && e.message) || e}`)
      out.set(shortId, cached
        ? { fullSessionId: cached.fullSessionId, groups: cached.groups, realTurns: cached.realTurns, cached: true }
        : null)
      continue
    }
    cache.sessions[shortId] = {
      logFile,
      mtimeMs: built.mtimeMs,
      size: built.size,
      fullSessionId: built.fullSessionId,
      groups: built.groups,
      realTurns: built.realTurns,
      usedAt: now,
    }
    dirty = true
    out.set(shortId, { fullSessionId: built.fullSessionId, groups: built.groups, realTurns: built.realTurns, cached: false })
  }

  if (dirty && workspace) saveCache(workspace, cache)
  return out
}

/** 绝对轮 → 组内真用户轮；插件续轮返回 null（没有用户原话可引）。 */
export function groupAt(alignment, absTurn) {
  if (!alignment || !Array.isArray(alignment.groups)) return null
  const n = Number(absTurn)
  if (!Number.isInteger(n) || n < 1) return null
  const g = alignment.groups[n - 1]
  if (!g || g.userSeq === null) return null
  return g
}

/**
 * 把一条编辑史事件翻译成"证据坐标"。
 *
 * - 单轮事件（jot/reflect 的 turn(n)）：取该轮组内的真用户轮
 * - 区间事件（turnRange(a,b)）：取素材轮 a..b-1 里**所有**真用户轮（最多 maxTurns 个）——
 *   记忆通常由若干轮素材归并而来，给区间比只给首轮更贴近"它到底吸收了什么"
 *
 * @returns {null | {短id, 绝对轮, 用户轮序号, userSeq, quote, scene, action}}
 */
export function locateEvent(alignment, ev) {
  const all = locateAll(alignment, ev)
  return all.length ? all[0] : null
}

/**
 * 同 {@link locateEvent}，但返回区间里的全部真用户轮（按绝对轮升序，最多 `maxTurns` 个）。
 * @returns {Array<{shortSession, absTurn, userSeq, quote, scene, action, range}>}
 */
export function locateAll(alignment, ev, options = {}) {
  if (!alignment || !ev || ev.unparsed) return []
  const maxTurns = Math.max(1, Number(options.maxTurns) || 6)
  const absList = ev.turnRange
    ? range(ev.turnRange[0], ev.turnRange[1] - 1)
    : [ev.turn]
  const out = []
  for (const abs of absList) {
    const g = groupAt(alignment, abs)
    if (!g) continue
    out.push({
      shortSession: ev.shortSession,
      absTurn: abs,
      userSeq: g.userSeq,
      quote: g.quote,
      scene: ev.scenario,
      action: ev.action,
      range: Boolean(ev.turnRange),
    })
    if (out.length >= maxTurns) break
  }
  return out
}

function range(a, b) {
  const out = []
  const lo = Math.max(1, Number(a) || 1)
  const hi = Math.max(lo, Number(b) || lo)
  for (let i = lo; i <= hi; i += 1) out.push(i)
  return out
}
