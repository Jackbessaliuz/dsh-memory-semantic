/**
 * injection-ledger —— 注入去重登记表（会话级、进程内）
 *
 * 为什么需要：同一个会话里，同一条记忆可能被塞两遍 ——
 *   ① meow-memory 的关键词命中注入（它自己的机制）
 *   ② 我们的动作触发注入（lib/action-trigger.js）
 *   ③ AI 主动检索的结果（memory_semantic 工具输出）
 * 重复内容不但白烧 token，还让"这条很重要"的强调失真（同一句说两遍就不再是强调）。
 *
 * 做法：以 sessionId 为键，登记"已经出现在这个会话里的记忆 id"，带 TTL；
 * 注入方在组装正文前先 filter 掉见过的，注入后把新增的 remember 进去。
 *
 * 关键设计：**登记靠"看到过就算"，包括别的插件注入的**——
 * 我们从会话消息文本里认 id（只读，不碰对方的数据），所以对
 * meow-memory 的注入同样有效，不需要它配合。
 */

/** 记忆 id 在文本里的形态（注入块形如 `[dsh : rules] [0mtq5t58k-e824466d0be0461a92ec73be94] 2026-09-28`）。 */
const MEMORY_ID_PATTERN = /\b0m[a-z0-9]{6,}-[0-9a-f]{8,}[0-9a-f-]*\b/g

/** 从任意文本里抓出记忆 id（去重）。 */
export function extractMemoryIds(text) {
  const s = String(text ?? '')
  if (!s) return []
  const out = new Set()
  for (const m of s.matchAll(MEMORY_ID_PATTERN)) out.add(m[0])
  return [...out]
}

/** 把若干消息（字符串或含 content 数组的消息对象）压成一段文本。 */
export function textOfMessages(messages) {
  if (!Array.isArray(messages)) return String(messages ?? '')
  const parts = []
  for (const m of messages) {
    if (!m) continue
    if (typeof m === 'string') { parts.push(m); continue }
    const content = m.content
    if (typeof content === 'string') { parts.push(content); continue }
    if (Array.isArray(content)) {
      for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/**
 * 创建登记表。
 * @param {{ ttlMs?: number, maxSessions?: number, now?: () => number }} options
 *   ttlMs：一条登记的有效期（默认 30 分钟——超过就允许重新注入，因为那时它多半
 *          已经被压缩/折叠掉了，再提一次是有价值的）
 *   maxSessions：最多跟踪多少个会话（防长跑进程内存无界增长），超出丢最旧的
 */
export function createLedger(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 30 * 60 * 1000
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : 64
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  /** @type {Map<string, Map<string, number>>} sessionId -> (memoryId -> 登记时刻) */
  const bySession = new Map()

  function prune(sessionId, at) {
    const bucket = bySession.get(sessionId)
    if (!bucket) return null
    for (const [id, t] of bucket) if (at - t > ttlMs) bucket.delete(id)
    if (bucket.size === 0) { bySession.delete(sessionId); return null }
    return bucket
  }

  function evictIfNeeded() {
    while (bySession.size > maxSessions) {
      const oldest = bySession.keys().next().value
      bySession.delete(oldest)
    }
  }

  return {
    /** 当前会话里"还算数"的已登记 id 集合。 */
    seen(sessionId) {
      const at = now()
      const bucket = prune(String(sessionId), at)
      return new Set(bucket ? bucket.keys() : [])
    },
    /** 过滤：返回 ids 里尚未登记过的那些（保持输入顺序）。 */
    filter(sessionId, ids) {
      const seen = this.seen(sessionId)
      return (Array.isArray(ids) ? ids : []).filter((id) => id && !seen.has(String(id)))
    },
    /** 登记：把这些 id 记为"本会话已经出现过"。空输入是 no-op。 */
    remember(sessionId, ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String)
      if (list.length === 0) return 0
      const key = String(sessionId)
      const at = now()
      const bucket = prune(key, at) || new Map()
      for (const id of list) bucket.set(id, at)
      bySession.set(key, bucket)
      evictIfNeeded()
      return list.length
    },
    /** 扫一段消息文本，把里面出现的记忆 id 全部登记（用于"别人注入的也算"）。 */
    observeText(sessionId, text) {
      return this.remember(sessionId, extractMemoryIds(text))
    },
    /** 忘记某个会话（会话结束/清理时用）。 */
    forget(sessionId) {
      return bySession.delete(String(sessionId))
    },
    /** 诊断用：{ sessions, entries }。 */
    stats() {
      const at = now()
      let entries = 0
      for (const sid of [...bySession.keys()]) {
        const bucket = prune(sid, at)
        if (bucket) entries += bucket.size
      }
      return { sessions: bySession.size, entries, ttlMs }
    },
    dispose() { bySession.clear() },
  }
}

export default createLedger
