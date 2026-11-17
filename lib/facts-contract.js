/**
 * facts-contract —— 记忆 → 事实三元组 的抽取契约（2026-11-19）
 *
 * 「事实索引」是 `.dsh-semantic/facts.json`：把记忆条目里**可核验的具体值**
 * （版本号 / 路径 / 状态 / 数量 / 日期）抽成 SPO 三元组，检索时当第 4 路反查用。
 *
 * 为什么单独成一层：它当初是用一次性脚本建的（2330 条靠 `facts-triples-full.json` 扁平化），
 * 脚本没留，于是**开源用户装完插件用不上这一路**。本文件把"怎么抽、怎么判合格、怎么归类"
 * 固化成可复用的契约，`scripts/build-facts.mjs` 负责批量跑。
 *
 * 三条硬要求（沿用既有产物的事实）：
 *  1. 只抽**可核验的事实**，不抽观点/推测/建议——检索反查只回答"值是多少"；
 *  2. 每条三元组必须带 `src`（记忆 id）与 `srcUpdatedAt`，否则记忆更新后无法失效；
 *  3. 抽不出来就是抽不出来，`ok:false` 如实记，不编造。
 */

/** 允许的 category（与既有 facts.json 对齐）。 */
export const FACT_CATEGORIES = ['版本', '路径', '状态', '数量', '日期', '配置', '实体']

/** 抽取工具的 schema（tools + 强制 tool_choice，与轮次抽取同风格）。 */
export const FACTS_TOOL = {
  type: 'function',
  function: {
    name: 'emit_facts',
    description: '从一条记忆中抽取可核验的事实三元组（subject-predicate-value）。没有可抽的就返回空数组。',
    parameters: {
      type: 'object',
      properties: {
        triples: {
          type: 'array',
          description: '可核验事实三元组；只抽明确的数值/路径/状态/日期，不抽观点与推测',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string', description: '实体：插件名 / 文件 / 组件 / 人 / 概念，尽量用记忆里的原名' },
              predicate: { type: 'string', description: '属性名：版本 / 路径 / 状态 / 数量 / 日期 / 配置项…（8 字以内）' },
              value: { type: 'string', description: '具体值，原样抄记忆里的写法，不要改写、不要概括' },
            },
            required: ['subject', 'predicate', 'value'],
          },
        },
      },
      required: ['triples'],
    },
  },
}

/** 构造一条消息序列（单条记忆一次抽取）。 */
export function buildFactsMessages(record) {
  const meta = [
    `层级：${record.level || '-'}`,
    `项目：${record.project || '（无）'}`,
    `更新时间：${record.updated_at ? new Date(Number(record.updated_at)).toISOString().slice(0, 10) : '-'}`,
  ].join('　')
  return [
    {
      role: 'system',
      content: [
        '你从一条记忆里抽取**可核验的事实**，供日后按"实体+属性"精确反查。',
        '',
        '抽什么：版本号、文件/目录路径、组件状态、数量、日期、明确配置项。',
        '不抽什么：观点、评价、建议、推测、承诺的语气、无法落到具体值的内容。',
        '',
        '规则：',
        '1. subject 尽量用记忆里的原名（插件名、文件名、人名、概念名），不要改写成同义词；',
        '2. predicate 简短（8 字以内），描述属性而不是句子；',
        '3. value 原样抄记忆里的写法——版本号带 v 就带 v，路径带反斜杠就带反斜杠；',
        '4. 一条记忆抽出 0~8 条都正常；宁可少抽，不要凑数；',
        '5. 没有可核验事实就返回空数组。',
      ].join('\n'),
    },
    { role: 'user', content: `${meta}\n\n记忆正文：\n${String(record.content || '').slice(0, 3000)}` },
  ]
}

/**
 * 按 value 的形态归类（规则分类，不花 LLM 调用）。
 * 与既有 facts.json 的分布对齐：版本 / 路径 / 状态 / 数量 / 日期 / 配置 / 实体。
 */
export function categorize(subject, predicate, value) {
  const v = String(value ?? '').trim()
  const p = String(predicate ?? '')
  if (/^\d{4}[-/年]\d{1,2}([-/月]\d{1,2})?日?/.test(v) || /^\d{1,2}月\d{1,2}日/.test(v)) return '日期'
  if (/^v?\d+\.\d+(\.\d+)?([-+][\w.]+)?$/i.test(v)) return '版本'
  if (/^[A-Za-z]:[\\/]/.test(v) || /^~[\\/]/.test(v) || /\\\\/.test(v) || /\.(mjs|js|json|md|bat|ps1|db|zstd|yml|yaml)$/i.test(v)) return '路径'
  if (/^\d+(\.\d+)?\s*(个|条|轮|次|MB|GB|KB|秒|ms|字|页|行|项)?$/i.test(v)) return '数量'
  if (/[=:]|=|：/.test(v) && v.length <= 40) return '配置'
  if (p.includes('状态') || /^(开|关|启用|禁用|已|未|正常|异常|失败|成功)/.test(v)) return '状态'
  return '实体'
}

/**
 * 解析模型输出 → 规范化的三元组数组。
 * @returns {{ok:boolean, triples:Array<{subject,predicate,value,category}>, error:string}}
 */
export function parseFacts(raw, record) {
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch { /* 下面按 tool 调用形态再试 */ }
  }
  // 兼容两种形态：直接对象 / { triples: [...] }
  const list = Array.isArray(data) ? data : (Array.isArray(data?.triples) ? data.triples : null)
  if (!list) return { ok: false, triples: [], error: '输出里没有 triples 数组' }
  const out = []
  for (const t of list) {
    if (!t || typeof t !== 'object') continue
    const subject = String(t.subject ?? '').trim()
    const predicate = String(t.predicate ?? '').trim()
    const value = String(t.value ?? '').trim()
    if (!subject || !predicate || !value) continue
    if (subject.length > 60 || predicate.length > 40 || value.length > 300) continue
    out.push({ subject, predicate, value, category: categorize(subject, predicate, value) })
  }
  return { ok: true, triples: out, error: '' }
}

/**
 * 把一批"每条记忆的抽取结果"扁平化成 facts.json 的结构。
 * @param {Array<{id,level,project,updated_at,triples}>} records
 */
export function flattenFacts(records) {
  const triples = []
  const seen = new Set()
  for (const r of records) {
    for (const t of (r.triples || [])) {
      const key = `${r.id}\u0000${t.subject}\u0000${t.predicate}\u0000${t.value}`
      if (seen.has(key)) continue
      seen.add(key)
      triples.push({
        src: String(r.id),
        level: String(r.level || ''),
        project: String(r.project || ''),
        updated_at: Number(r.updated_at) || 0,
        subject: t.subject,
        predicate: t.predicate,
        value: t.value,
        category: t.category || categorize(t.subject, t.predicate, t.value),
        srcUpdatedAt: Number(r.updated_at) || 0,
      })
    }
  }
  return { version: 1, updatedAt: Date.now(), count: triples.length, triples }
}
