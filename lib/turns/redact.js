/**
 * redact —— 密钥脱敏闸门（2026-10-06 新增）
 *
 * 为什么要有这个文件：
 *   轮次记忆是**自动**从真实对话里长出来的：`turn/end` → 投影 → 抽取 → 入库。
 *   只要一串密钥进过对话（用户贴的、工具输出回显的、我自己的排查日志），
 *   它就会被原样当成"有信息量的轮次内容"写进 `turns.db`，
 *   再随 `recall_turns` 被检索、被注入回对话、被备份复制出去。
 *
 *   2026-10-06 实测的教训：GitHub token 与 DeepSeek 官方 key 都走过这条路，
 *   18+ 处明文落进记忆库与备份。**"我没写进文件"这种保证是不成立的**——
 *   记忆系统本身就是一台"什么都记"的机器，所以闸门必须装在这台机器上，而不是装在自觉上。
 *
 * 设计三条：
 *  1. **单一收口**：所有落盘入口（store.upsertTurn / store.replaceTriples /
 *     recall-shadow 的 queryHead）都过这里，不靠各调用点自觉。
 *  2. **幂等**：替换标记 `[已脱敏:…]` 本身不匹配任何规则，重复跑结果不变。
 *  3. **不改语义**：只替换"值"，保留字段名与上下文，摘要/三元组的可用性不受影响。
 */

/** 规则表：先窄后宽（`sk-ant-` 必须在通用 `sk-` 之前，否则会被截断成 sk-ant-…）。 */
const RULES = [
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,255}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,255}/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,255}/g },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,255}/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
]

/**
 * 带标签的赋值形态：`apiKey: xxxx` / `password = xxxx`。
 * 保留字段名（key 名是上下文，不是秘密），只把值换掉。
 */
const LABELED = /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|passwd|password|token)\s*["'`]?\s*[:=]\s*["'`]?)([A-Za-z0-9._~+/=-]{16,})/gi

export const REDACT_MARK = '[已脱敏'

/** 单个字符串脱敏（纯函数、幂等）。 */
export function redactSecrets(input) {
  if (typeof input !== 'string' || !input) return input
  let out = input
  for (const rule of RULES) out = out.replace(rule.re, `[已脱敏:${rule.name}]`)
  out = out.replace(LABELED, (_m, label, _value) => `${label}[已脱敏:credential]`)
  return out
}

/** 是否含有需要脱敏的内容（自测/回填巡检用，不需要替换时省钱）。 */
export function hasSecret(input) {
  if (typeof input !== 'string' || !input) return false
  return redactSecrets(input) !== input
}

/**
 * 结构递归脱敏：只改 string 叶子，不动结构与类型（三元组、JSON 记录都走这里）。
 * 深度上限 + 循环引用保护，避免病态输入把闸门本身拖垮。
 */
export function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object' || depth > 8) return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1, seen))
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, depth + 1, seen)
  return out
}

/** 统计用：返回命中的规则名列表（诊断/自测输出，不含明文）。 */
export function secretKinds(input) {
  if (typeof input !== 'string' || !input) return []
  const kinds = []
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(input)) kinds.push(rule.name)
  }
  LABELED.lastIndex = 0
  if (LABELED.test(input)) kinds.push('credential')
  return kinds
}
