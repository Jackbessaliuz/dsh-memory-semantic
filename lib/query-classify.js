/**
 * query-classify —— 查询意图分类（2026-11-15 第二批）
 *
 * 为什么需要：检索只有一套融合策略，但问题分两类——
 *   事实型（"市场有多少个插件"）需要精确匹配，语义相似度帮不上；
 *   话题型（"为什么决定不上 Neo4j"）恰恰是语义检索的强项。
 * 先分类，才能给两类问题不同的检索路线（facts 路先接账本观测，后续再接）。
 *
 * 原则：纯规则、零成本、可解释。宁可分错成 mixed，也不要引入模型调用。
 */

const FACT_RE = /(多少|几个|几条|几号|版本|价格|多少钱|多久|什么时候|日期|多大|多长|多远|总数|数量|百分比|占比|金额|几月|第几|几年|几次|涨跌|单价)/
const TOPIC_RE = /(为什么|为啥|怎么|如何|当初|决定|原因|背景|经过|思路|考虑|怎么想|图什么|凭什么|意义|意味着|影响|关系|区别|对比|打算)/
const TIME_RE = /(上次|最近|现在|目前|当前|以前|后来|之前|之后|变化|更新|旧的|新的)/

export function classifyQuery(query) {
  const s = String(query || '')
  const fact = FACT_RE.test(s)
  const topic = TOPIC_RE.test(s)
  const time = TIME_RE.test(s)
  if (fact && !topic) return { type: 'fact', fact, topic, time }
  if (topic && !fact) return { type: 'topic', fact, topic, time }
  if (fact && topic) return { type: 'mixed', fact, topic, time }
  // 只命中时间词（"最近一次定的起点"）或完全没信号：按话题处理——
  // 时间词只是修饰，不该把话题题判成事实题。
  return { type: 'topic', fact, topic, time }
}

/** 给账本/调试用的紧凑标签 */
export function classifyTag(query) {
  return classifyQuery(query).type
}

export default classifyQuery
