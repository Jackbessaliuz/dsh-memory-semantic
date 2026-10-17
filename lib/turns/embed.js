/**
 * embed —— 本地向量（Ollama bge-m3）
 *
 * 与记忆条目层同一个引擎：数据不出门、零 API 费用。不可达时**fail-open**——
 * 调用方拿到 null，走严格词法回退，绝不因为向量服务挂了就阻塞对话。
 */
const OLLAMA = process.env.MEMORY_SEMANTIC_OLLAMA || 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.MEMORY_SEMANTIC_MODEL || 'bge-m3'
/**
 * embed 请求超时（2026-10-18 M8 修法）：原先 fetch 没有 AbortSignal，
 * Ollama「TCP 已连接但不响应」（模型加载中、GPU 卡死、端口被占）时该 await 永不返回；
 * 而 processTurn 在每会话串行链上 —— 一次挂死，这个会话后续每一轮都排在死链后面，
 * 记忆永久停止增长（不是 fail-open，是 fail-hang）。
 * 8 秒足够 bge-m3 冷启动；超时按 fail-open 跳过本轮向量，词法路径照常。
 */
const EMBED_TIMEOUT_MS = 8000
/** bge-m3 官方推荐的中文检索指令（不加会显著掉分）。 */
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

export function embedModel() {
  return EMBED_MODEL
}

/** 批量取向量；失败抛错（由调用方决定是否降级）。 */
export async function embedTexts(inputs) {
  const list = Array.isArray(inputs) ? inputs : [inputs]
  if (list.length === 0) return []
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: list }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`embed HTTP ${response.status}`)
  const json = await response.json()
  if (!Array.isArray(json.embeddings)) throw new Error('embed 响应缺少 embeddings')
  return json.embeddings
}

/** 取查询向量；任何失败都返回 null（调用方降级为词法）。 */
export async function embedQuery(query) {
  try {
    const [vector] = await embedTexts([QUERY_PREFIX + String(query ?? '')])
    return Array.isArray(vector) ? vector : null
  } catch {
    return null
  }
}

export async function ollamaHealthy() {
  try {
    const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!response.ok) return false
    const json = await response.json()
    return Array.isArray(json.models) && json.models.some((m) => String(m.name ?? '').startsWith(EMBED_MODEL))
  } catch {
    return false
  }
}
