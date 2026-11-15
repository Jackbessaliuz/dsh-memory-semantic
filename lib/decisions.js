/**
 * decisions.js —— 决策—结果记录（2026-11-15 最后部分）
 *
 * 为什么叫"决策—结果"而不是"因果记忆"：GPT 评审时坚持——我们只能记录
 * "某决策之后观察到了某结果"，不能断言因果。所以字段里刻意区分
 * expected（预期）与 actual（实际）、status（成功/失败/未知），
 * 并且关系语义固定为 observed_after。
 *
 * 存储：<workspace>/.dsh-semantic/decisions.json（独立文件，不碰 meow-memory 基座）
 * 只写自己的库 —— 与只读增强层的边界一致（增强层允许在独立 DB 里存账本/派生数据）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_RECORDS = 500

export function decisionsPathOf(workspace) {
  return path.join(workspace, '.dsh-semantic', 'decisions.json')
}

export function loadDecisions(workspace) {
  try {
    const p = decisionsPathOf(workspace)
    if (!fs.existsSync(p)) return { version: 1, records: [] }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(j.records) ? j : { version: 1, records: [] }
  } catch { return { version: 1, records: [] } }
}

function saveDecisions(workspace, data) {
  const p = decisionsPathOf(workspace)
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const trimmed = data.records.slice(-MAX_RECORDS)
  fs.writeFileSync(p, JSON.stringify({ ...data, records: trimmed }, null, 1))
}

/** 记录一条决策—结果；返回落盘后的记录（含 id/时间）。 */
export function recordDecision(workspace, input) {
  const data = loadDecisions(workspace)
  const now = Date.now()
  const rec = {
    id: 'dec-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    relation: 'observed_after', // 固定语义：之后观察到，不是因果
    goal: String(input.goal || '').slice(0, 500),
    constraints: toList(input.constraints),
    options: toList(input.options),
    chosen: String(input.chosen || '').slice(0, 300),
    reason: String(input.reason || '').slice(0, 800),
    evidence: toList(input.evidence),
    expected: String(input.expected || '').slice(0, 500),
    actual: String(input.actual || '').slice(0, 500),
    conditions: toList(input.conditions),
    status: ['succeeded', 'failed', 'unknown'].includes(input.status) ? input.status : 'unknown',
    tags: toList(input.tags),
    createdAt: now,
    updatedAt: now,
  }
  data.records.push(rec)
  saveDecisions(workspace, data)
  return rec
}

function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map((s) => String(s).slice(0, 300))
  if (typeof v === 'string' && v.trim()) return [v.trim().slice(0, 300)]
  return []
}

export function listDecisions(workspace, { limit = 10, status, tag } = {}) {
  const data = loadDecisions(workspace)
  let rows = data.records.slice()
  if (status) rows = rows.filter((r) => r.status === status)
  if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag))
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(50, limit)))
}

export function getDecision(workspace, id) {
  return loadDecisions(workspace).records.find((r) => r.id === id) || null
}

/** 供检索使用的轻量索引：把 goal/chosen/reason/actual 拼成检索串 */
export function decisionSearchText(rec) {
  return [rec.goal, rec.chosen, rec.reason, rec.expected, rec.actual, ...(rec.conditions || [])].filter(Boolean).join(' ')
}
