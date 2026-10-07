/**
 * extract-contract —— 统一抽取合同（每个完成轮恰好一次调用）
 *
 * 移植自 graph-memory 1.6.0-beta.16 `src/extractor/contract.ts` + `extract.ts`。
 * 语义一条不改，只把 TypeBox 换成手写校验（我们手写 bundle、零构建、零新依赖）。
 *
 * 三条不可动摇的规则：
 *  1. **一次调用同时产出 summary / outcome / triples**——绝不拆成两次 LLM 调用，
 *     否则成本翻倍，两个结果还可能互相矛盾；
 *  2. **只做 JSON.parse + 字段合同校验**——不做 JSON repair、不补默认字段、
 *     不做语义门禁、不因"关系方向看起来不合理"而拒绝模型输出；
 *  3. **坏数据不能伪装成成功数据**：不合法就抛错，由调用方隔离该轮（不猜、不补、不污染图谱）。
 *
 * 隐私：抽取输出可能含私人对话事实，所以错误信息里**绝不回显模型原文**。
 */
import { OUTCOMES } from './schema.js'

export const EXTRACTION_TOOL_NAME = 'submit_result'

/**
 * Provider-facing 合同（扁平、三字段全必填、additionalProperties: false）。
 * 保持扁平和单一 enum，比嵌套 required 与 anyOf 字面量更容易被各家 provider 正确遵循；
 * 运行时仍然逐字段校验——provider schema 只是建议，不是保证。
 */
export const EXTRACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'outcome', 'triples'],
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      description: '本轮对话的自包含一句话摘要（必填）。',
    },
    outcome: {
      type: 'string',
      enum: [...OUTCOMES],
      description: '本轮最终状态（必填）。',
    },
    triples: {
      type: 'array',
      description: '只从 summary 拆出的主语—谓词—宾语关系；没有明确关系时用空数组。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'predicate', 'object'],
        properties: {
          subject: { type: 'string', minLength: 1, description: '具体可检索的主语短语。' },
          predicate: { type: 'string', minLength: 1, description: '简短关系短语。' },
          object: { type: 'string', minLength: 1, description: '具体可检索的宾语短语。' },
        },
      },
    },
  },
})

export const EXTRACTION_TOOL = Object.freeze({
  name: EXTRACTION_TOOL_NAME,
  description: '提交且仅提交 summary、outcome、triples 三个必填字段。零条或多条 SPO 只从 summary 拆分；没有明确关系时 triples 必须是 []。不要输出正文。',
  parameters: EXTRACTION_SCHEMA,
})

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const keysExactly = (obj, expected) => {
  const keys = Object.keys(obj)
  return keys.length === expected.length && expected.every((k) => keys.includes(k))
}

/**
 * 逐字段校验（等价于上游 TypeBox 的 Value.Check + Value.Errors）。
 * @returns { ok: boolean, errors: string[] } —— errors 只含路径与原因，不含模型文本
 */
export function validateExtraction(value) {
  const errors = []
  if (!isPlainObject(value)) return { ok: false, errors: ['/ 抽取结果必须是 JSON 对象'] }
  if (!keysExactly(value, ['summary', 'outcome', 'triples'])) {
    const extra = Object.keys(value).filter((k) => !['summary', 'outcome', 'triples'].includes(k))
    const missing = ['summary', 'outcome', 'triples'].filter((k) => !Object.hasOwn(value, k))
    if (missing.length) errors.push(`缺少必填顶层字段: ${missing.join(', ')}`)
    if (extra.length) errors.push(`不允许的额外顶层字段: ${extra.join(', ')}`)
  }
  if (typeof value.summary !== 'string' || value.summary.length < 1) {
    errors.push('/summary 必须是非空字符串')
  }
  if (typeof value.outcome !== 'string' || !OUTCOMES.includes(value.outcome)) {
    errors.push(`/outcome 必须是 ${OUTCOMES.join('/')} 之一`)
  }
  if (!Array.isArray(value.triples)) {
    errors.push('/triples 必须是数组')
  } else {
    value.triples.forEach((triple, index) => {
      if (!isPlainObject(triple)) {
        errors.push(`/triples/${index} 必须是对象`)
        return
      }
      if (!keysExactly(triple, ['subject', 'predicate', 'object'])) {
        errors.push(`/triples/${index} 必须且只能含 subject、predicate、object`)
      }
      for (const field of ['subject', 'predicate', 'object']) {
        if (typeof triple[field] !== 'string' || triple[field].length < 1) {
          errors.push(`/triples/${index}/${field} 必须是非空字符串`)
        }
      }
    })
  }
  return { ok: errors.length === 0, errors }
}

/** 合同不完整时立即失败（fail closed）。错误里不回显模型输出。 */
export function assertExtractionContract(value) {
  const { ok, errors } = validateExtraction(value)
  if (ok) return value
  throw new TypeError(`抽取合同不满足: ${errors.slice(0, 3).join('; ')}`)
}

/** 只读可见文本：把各种宿主消息形态归一化成纯文本（照上游语义）。 */
export function normalizeTurnContent(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .filter((block) => isPlainObject(block))
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text))
      .join('\n')
  }
  if (!isPlainObject(value)) return String(value)
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  if (value.content !== undefined) return normalizeTurnContent(value.content)
  if (value.message !== undefined) return normalizeTurnContent(value.message)
  return ''
}

/* ── 提示词 ────────────────────────────────────────────────────────── */

export const EXTRACT_SYSTEM_PROMPT = `【任务】
把一个已完成的对话轮转换为一句摘要和零条或多条主语—谓词—宾语关系。

【输入】
- Current Turn 是本轮唯一事实来源，只含用户输入和最终可见回答。
- Previous Turn Summaries 仅用于消解代词、省略和"继续上一个"等指代，不能作为本轮事实重复输出。

【处理原则】
1. summary 用一句简短、自包含的话写清本轮对象、结论和最终回答明确报告的完成情况；不复述过程，不添加输入未表达的信息。
2. outcome 按最终回答选择 completed、partial、failed、informational、unknown 之一。
3. triples 只从 summary 拆分。subject 和 object 使用具体可检索短语，predicate 使用简短自然语言；没有明确关系时使用空数组，不补充、不猜测。

【输出合同】
只调用 submit_result 一次。参数对象必须且只能包含 summary、outcome、triples 三个顶层字段，三个字段都不能省略。不要输出解释或正文。

示例一：
输入：用户要求把周会改到周四；最终回答确认日程已更新。
输出：{"summary":"周会已改到周四，日程已更新。","outcome":"completed","triples":[{"subject":"周会","predicate":"改到","object":"周四"}]}

示例二：
前一轮摘要为"季度报告已完成初稿"。本轮用户说"继续这个"，最终回答说"已完成数据复核"。
输出：{"summary":"季度报告初稿已完成数据复核。","outcome":"completed","triples":[{"subject":"季度报告初稿","predicate":"完成","object":"数据复核"}]}

示例三：
输入只确认稍后继续讨论，没有新结论。
输出：{"summary":"本轮确认稍后继续讨论，未产生新结论。","outcome":"informational","triples":[]}

调用前自检：参数是否恰好包含三个顶层字段；outcome 是否属于枚举；没有关系时 triples 是否仍明确写为 []。`

/**
 * 组装 user prompt。
 * @param input.userText 本轮用户问题（已剥离注入）
 * @param input.answerText 本轮最终可见回答（已排除 reasoning）
 * @param input.priorSummaries 前若干轮摘要（仅用于消解指代）
 */
export function buildExtractUserPrompt(input) {
  const prior = Array.isArray(input?.priorSummaries) ? input.priorSummaries.filter((s) => typeof s === 'string' && s.trim()) : []
  const turn = [
    `用户：${normalizeTurnContent(input?.userText)}`,
    `回答：${normalizeTurnContent(input?.answerText)}`,
  ].join('\n\n---\n\n')
  return `<Previous Turn Summaries>
${prior.length ? JSON.stringify(prior) : '（无）'}

<Current Turn>
${turn}`
}

/** 组装完整消息体（接 LLM 时直接喂）。 */
export function buildExtractMessages(input) {
  return [
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: buildExtractUserPrompt(input) },
  ]
}

/**
 * 解析 provider 返回的**工具参数字符串**。
 * 只做 JSON.parse + 合同校验；失败抛错（错误信息不含模型原文）。
 */
export function parseExtraction(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('抽取结果为空：没有收到 submit_result 的工具参数')
  let parsed
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new TypeError('抽取结果不是合法 JSON（不做 repair，直接隔离该轮）')
  }
  if (!isPlainObject(parsed)) throw new TypeError('抽取结果根必须是 JSON 对象')
  assertExtractionContract(parsed)
  return {
    summary: parsed.summary,
    outcome: parsed.outcome,
    triples: parsed.triples.map((triple) => ({ ...triple })),
  }
}
