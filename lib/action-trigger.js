/**
 * 动作触发记忆注入（dsh-memory-semantic · 机制层 v1）
 *
 * 目的：把「遇到难题 → 主动翻经验 → 用上」从「靠模型自己想起来」变成「由运行时兜底」。
 * 做法：在关键工具调用结束后，按可配置规则自动检索记忆库，把命中的红线/教训
 *      附加到下一次模型请求（tools/post-execute → PostToolDecision.additionalContexts）。
 *
 * 设计约束：
 *  - 只读记忆库（<workspace>/.dsh-meow/memory.db），不碰 meow-memory 一字节；
 *  - 检索走轻量 BM25（零 Ollama 依赖、不阻塞工具调用）；索引已在内存时可切向量（v2）；
 *  - 任何失败静默降级，绝不影响工具结果本身；
 *  - 同一规则 + 同一工作区有冷却，避免刷屏；
 *  - 规则表来自插件 config.actionTriggers.rules（内置一条 dsh 改插件规则作为默认）。
 *
 * 为什么挂在 tools/post-execute 而不是 pre-execute：
 *   DSH 的 PreToolDecision 只有 allow/deny/ask，**不能附加 context**；
 *   PostToolDecision 才有 additionalContexts（"attach context for the next request"）。
 *   所以"动手前提醒"的实际落点是：这次动作结束后立刻注入 → 模型下一步就能看到。
 */
import fs from 'node:fs'

import { injectionSource } from './source-kind.js'

const PLUGIN = 'dsh-memory-semantic'
const SUMMARY_MAX = 120
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000
const DEFAULT_K = 3
const DEFAULT_ITEM_CHARS = 220
const DEFAULT_TOTAL_CHARS = 900
const ARG_SCAN_CHARS = 4000

/**
 * 内置默认规则：2026-09-09 第三次 bundles 双挂载事故后订。
 * 只要动作看起来在动 DSH 的插件/组合/启动脚本，就把 dsh 项目的红线与教训捞出来。
 * 其它项目工作区里记忆库没有 dsh 条目，命中为空 → 自然不注入。
 */
const DEFAULT_RULES = [
  {
    id: 'dsh-plugin-change',
    label: '改插件 / 组合 / 启动脚本',
    tools: ['pwsh', 'bash', 'write', 'edit', 'str_replace_editor'],
    match: 'install\\.js|dsh plugin add|bundles|cordis\\.patch|package\\.json|agent-presets|preset\\.yml|回滚插件|\\.bat',
    query: '改插件 bundles 双挂载 红线 事故 教训 回滚 验证',
    project: 'dsh',
    levels: ['rules', 'lesson'],
    k: DEFAULT_K,
  },
]

function asArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/** 归一化 config.actionTriggers：enabled 默认为真，规则缺省用内置表。 */
export function normalizeRules(config) {
  const cfg = config && typeof config === 'object' ? config.actionTriggers : null
  if (cfg && cfg.enabled === false) return []
  const raw = cfg && Array.isArray(cfg.rules) ? cfg.rules : DEFAULT_RULES
  const rules = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const id = String(r.id || '').trim()
    const query = String(r.query || '').trim()
    if (!id || !query) continue
    let match = null
    if (r.match) {
      try { match = new RegExp(String(r.match), 'i') } catch { match = null }
    }
    rules.push({
      id,
      label: String(r.label || id),
      tools: asArray(r.tools),
      match,
      query,
      project: r.project ? String(r.project) : '',
      levels: asArray(r.levels),
      k: Math.max(1, Math.min(10, Number(r.k) || DEFAULT_K)),
      cooldownMs: Math.max(0, Number(r.cooldownMs) || DEFAULT_COOLDOWN_MS),
      maxChars: Math.max(80, Number(r.maxChars) || DEFAULT_TOTAL_CHARS),
    })
  }
  return rules
}

function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  if (process.env.DSH_WORKSPACE) return process.env.DSH_WORKSPACE
  return null
}

/** 把调用参数压成一小段可匹配文本：优先命令/路径字段，其次整体 JSON 截断。 */
export function serializeArgs(args) {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args.slice(0, ARG_SCAN_CHARS)
  const picked = []
  if (typeof args === 'object') {
    for (const key of ['command', 'file_path', 'path', 'filePath', 'pattern', 'query', 'name']) {
      const v = args[key]
      if (typeof v === 'string' && v) picked.push(v)
    }
  }
  let json = ''
  try { json = JSON.stringify(args) } catch { json = '' }
  return (picked.join('\n') + '\n' + json).slice(0, ARG_SCAN_CHARS)
}

/** 找出第一条命中的规则；没有命中返回 null。 */
export function matchRule(rules, exec) {
  const toolName = String(exec?.name || '')
  const haystack = serializeArgs(exec?.arguments)
  for (const rule of rules) {
    if (rule.tools.length > 0 && !rule.tools.includes(toolName)) continue
    if (rule.match && !rule.match.test(haystack)) continue
    return rule
  }
  return null
}

/** 在记忆行上做 BM25 检索 + project/level 过滤，返回 top-k 行。 */
export function selectMemories(rows, buildBM25, rule) {
  const wantProjects = rule.project ? rule.project.split(',').map((s) => s.trim()).filter(Boolean) : []
  const filtered = rows.filter((r) => {
    if (!r || r.status === 'archived') return false
    if (wantProjects.length > 0) {
      const proj = String(r.project || '').split(',').map((s) => s.trim())
      if (!wantProjects.some((p) => proj.includes(p))) return false
    }
    if (rule.levels.length > 0 && !rule.levels.includes(r.level)) return false
    return true
  })
  if (filtered.length === 0) return []
  const docs = filtered.map((r) => ({ id: r.id, text: `${r.content || ''} ${r.keywords || ''}` }))
  const byId = new Map(filtered.map((r) => [r.id, r]))
  return buildBM25(docs)(rule.query)
    .slice(0, rule.k)
    .map((s) => byId.get(s.id))
    .filter(Boolean)
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 组装注入正文（受 rule.maxChars 约束，保证注入体积可控）。 */
export function buildInjectionText(rule, hits, exec) {
  const head = `【记忆自动注入 · ${PLUGIN}】\n检测到动作「${rule.label}」（工具 ${exec?.name || '?'}），自动检索记忆库如下 —— 动手前请先读：`
  const lines = []
  let used = head.length
  hits.forEach((r, i) => {
    const line = `${i + 1}. [${r.level || '-'}${r.project ? '/' + r.project : ''}] ${clip(r.content, DEFAULT_ITEM_CHARS)}`
    if (used + line.length > rule.maxChars) return
    lines.push(line)
    used += line.length + 1
  })
  const tail = '（本注入由动作触发规则自动完成，与当前任务无关时可忽略。）'
  return [head, ...lines, tail].join('\n')
}

// ---------- 注入消息构造（懒加载官方工厂，失败则手写降级） ----------
let msgFactoryPromise = null
function loadMsgFactory() {
  if (!msgFactoryPromise) {
    msgFactoryPromise = import('@deepseek-ai/dsh-llm')
      .then((m) => (typeof m.createUserMessage === 'function' ? m.createUserMessage : null))
      .catch(() => null)
  }
  return msgFactoryPromise
}

async function makeMessage(text, rule) {
  const content = [{ type: 'text', text }]
  const source = await injectionSource(PLUGIN, clip(`记忆自动注入：${rule.label}`, SUMMARY_MAX))
  const factory = await loadMsgFactory()
  if (factory) {
    try { return factory({ content, source }) } catch { /* 降级 */ }
  }
  return {
    id: `mem-sem-trigger-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    source,
  }
}

/**
 * 注册动作触发。依赖由 index.js 注入，避免循环 import。
 * @param ctx Cordis 上下文（用于 ctx.on）
 * @param deps {{ logger, config, readMemories, buildBM25, dbPathOf }}
 */
export function registerActionTriggers(ctx, deps) {
  const { logger, config, readMemories, buildBM25, dbPathOf, ledger = null } = deps
  const rules = normalizeRules(config)
  if (rules.length === 0) {
    logger && logger.info('dsh-memory-semantic: action triggers off (no rules)')
    return
  }
  const lastFired = new Map()

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      const rule = matchRule(rules, exec)
      if (!rule) return decision
      const workspace = workspaceOf(exec)
      if (!workspace) return decision
      const key = `${rule.id}|${workspace}`
      const now = Date.now()
      if (now - (lastFired.get(key) || 0) < rule.cooldownMs) return decision
      const dbFile = dbPathOf(workspace)
      if (!fs.existsSync(dbFile)) return decision
      const all = selectMemories(readMemories(dbFile), buildBM25, rule)
      // 去重（2026-10-07）：本会话已经出现过的记忆（meow-memory 注入过、或我们上次注入过）
      // 不再重复塞 —— 重复不但白烧 token，还会让"这条很重要"的强调失真。
      const sessionId = String(exec?.agent?.session?.header?.id ?? '')
      const hits = ledger && sessionId ? all.filter((r) => ledger.filter(sessionId, [r.id]).length > 0) : all
      if (hits.length === 0) return decision
      const text = buildInjectionText(rule, hits, exec)
      const message = await makeMessage(text, rule)
      if (!message) return decision
      lastFired.set(key, now)
      if (ledger && sessionId) ledger.remember(sessionId, hits.map((r) => r.id))
      logger && logger.info(`dsh-memory-semantic: action trigger「${rule.label}」注入 ${hits.length} 条记忆（${text.length} 字符）`)
      const prior = Array.isArray(decision && decision.additionalContexts) ? decision.additionalContexts : []
      return { ...decision, additionalContexts: [...prior, message] }
    } catch (error) {
      logger && logger.warn && logger.warn(`dsh-memory-semantic: action trigger 失败（已忽略）：${(error && error.message) || error}`)
      return decision
    }
  })

  logger && logger.info(`dsh-memory-semantic: action triggers on（${rules.length} 条规则：${rules.map((r) => r.id).join(', ')}）`)
}

export { DEFAULT_RULES }
