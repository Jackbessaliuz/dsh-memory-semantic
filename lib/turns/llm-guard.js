/**
 * LLM 调用守卫 —— 对齐上游 graph-memory `src/engine/llm-guard.js`（2026-10-08）
 *
 * 为什么需要它：抽取链路会在后台持续调 LLM。如果凭证失效（401）、端点或模型名配错
 * （403/404），每一次抽取都会白跑一遍、白花一次钱，而问题并不会自己好——原先我们
 * 是"每轮都试一次、失败了就记一笔"，等于把钱和日志一起烧掉。
 *
 * 上游的做法是**把错误分成三档**，我们照抄这个分类（连同它的理由）：
 *
 *   ① 429 / 500 / 502 / 503 / 529 —— 暂时性，**可重试**
 *      （重试节奏交给队列的 next_retry_at 退避，见 store.markExtraction）
 *   ② 401 / 403 / 404 —— 需要改凭证／端点／模型配置，**暂停冷却**（默认 10 分钟），
 *      期间不做任何抽取，等人工介入
 *   ③ 其它（含 400 / 422）—— **不暂停**。上游注释写得很准：
 *      「400/422 可能只是**一个坏 prompt** 引起的，不能让它禁用后续不相关的调用」
 *
 * 一句话：**别让一个坏输入毒死整条流水线，也别在注定失败时反复烧钱。**
 */

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const PAUSING_STATUSES = new Set([401, 403, 404])
const DEFAULT_COOLDOWN_MS = 10 * 60_000

/**
 * 从错误里抠出 HTTP 状态码。
 * 上游正则是 `/\b(?:LLM|Anthropic) API (\d{3})\b/`；DSH 这边实测错误文本形如
 * `LLM API 401 ...`，另外我们多认两种常见形态（对象上的 status、`statusCode=401`），
 * 认不出就返回 null（→ 按"不暂停"处理，宁可多试一次也不误停）。
 */
export function extractLlmStatus(error) {
  if (error && typeof error === 'object') {
    for (const key of ['status', 'statusCode', 'code']) {
      const v = Number(error[key])
      if (Number.isFinite(v) && v >= 100 && v < 600) return v
    }
  }
  const text = String((error && error.message) || error || '')
  const api = text.match(/\b(?:LLM|Anthropic|OpenAI|DeepSeek) API (\d{3})\b/)
  if (api) return Number(api[1])
  const bare = text.match(/\bstatus(?:Code)?["'\s:=]{0,4}(\d{3})\b/i)
  return bare ? Number(bare[1]) : null
}

export class LlmFailureGuard {
  constructor(cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now()) {
    this.cooldownMs = Number.isFinite(cooldownMs) ? cooldownMs : DEFAULT_COOLDOWN_MS
    this.now = now
    this.pausedUntil = 0
  }

  /** 现在能不能干活（暂停期内一律跳过，不发起请求）。 */
  canRun() {
    return this.now() >= this.pausedUntil
  }

  remainingMs() {
    return Math.max(0, this.pausedUntil - this.now())
  }

  /** 给人看的剩余时间，用于日志。 */
  remainingText() {
    const ms = this.remainingMs()
    if (!ms) return ''
    const min = Math.ceil(ms / 60_000)
    return `${min} 分钟后重试`
  }

  /** 人工确认配置已修好后调用，立刻恢复。 */
  reset() {
    this.pausedUntil = 0
  }

  /**
   * 按错误决定要不要拉闸。返回是否**本次触发了暂停**。
   * 注意：可重试的（429/5xx）与其它（含 400/422）都不触发暂停。
   */
  tripIfNeeded(error) {
    const status = extractLlmStatus(error)
    if (status === null) return false
    if (RETRYABLE_STATUSES.has(status)) return false
    if (!PAUSING_STATUSES.has(status)) return false
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.cooldownMs)
    return true
  }
}
