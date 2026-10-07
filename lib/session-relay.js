/**
 * 跨会话接力（session relay）· dsh-memory-semantic
 *
 * 目的（维护者 2026-09-19 拍板）：
 *   他为了省缓存 token + 保持结构清晰，习惯「一个任务一个会话、20-30 轮就换新会话」；
 *   换会话时他期望新会话能自动接上，而不是他手打上下文。
 *   本模块把这件事变成**运行时兜底**：新会话说「继续」，自动把上个会话的尾巴接进来。
 *
 * 为什么不做"交接卡"：
 *   卡片要有人写（靠模型自觉），而"上个会话的尾巴"本身就能从会话日志抽出来 ——
 *   零维护成本、零自觉依赖，覆盖面还更大（连被 dream 跳过的会话也能兜住）。
 *   所以 v1 直接做**自动抽取**，卡片留作 v2 可选项。
 *
 * 落点与证据（照抄 meow-memory 的成熟范式）：
 *   - 钩子：`agent/pre-step`（waterfall）。它的 PreStepDecision 只有 reject / enter，
 *     但 enter 里能**替换"进入这一步的消息"** → 把接力块作为一条 plugin 消息
 *     插到最后一条用户消息之前即可（meow-memory 的 snapshot 正是这么做的）。
 *   - 只认真实用户消息（`source.kind === 'user'`），跳过 plugin 注入物；
 *   - 子代理会话（`origin === 'subagent'`）不注入；
 *   - fail-open：任何异常都原样放行，绝不影响正常对话。
 *
 * 成本控制：
 *   - 命中触发词才动作；只在本会话前 N 轮（默认 3）尝试；每个会话最多注入一次；
 *   - 会话日志是**多帧 zstd**（v3 格式），只解**最后若干帧**，不读全文；
 *   - 结果按 sid 缓存在 `<workspace>/.dsh-semantic/relay-state.json`，重复请求不重复解压；
 *   - 注入正文硬上限 maxChars（默认 2000）。
 *
 * 只读：本模块不写任何 DSH 数据，只写自己工作区里的 `.dsh-semantic/relay-state.json`。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

import { injectionSource } from './source-kind.js'

const PLUGIN = 'dsh-memory-semantic'
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const DEFAULT_TRIGGER = '继续|接着|接上|上次|上一个会话|上个会话|隔壁|继承一下|聊到哪|说到哪'
const DEFAULT_MAX_CHARS = 2000
const DEFAULT_FRAMES = 12
const DEFAULT_TURNS = 3
const DEFAULT_TAIL_TURNS = 6

/** 归一化配置：整块默认开启；config.sessionRelay.enabled=false 可关。 */
export function normalizeRelayConfig(config) {
  const cfg = (config && typeof config === 'object' && config.sessionRelay) || {}
  if (cfg.enabled === false) return null
  let trigger = null
  try { trigger = new RegExp(String(cfg.trigger || DEFAULT_TRIGGER), 'i') } catch { trigger = new RegExp(DEFAULT_TRIGGER, 'i') }
  return {
    trigger,
    maxChars: Math.max(400, Number(cfg.maxChars) || DEFAULT_MAX_CHARS),
    frames: Math.max(2, Math.min(80, Number(cfg.frames) || DEFAULT_FRAMES)),
    maxTurns: Math.max(1, Math.min(10, Number(cfg.maxTurns) || DEFAULT_TURNS)),
    tailTurns: Math.max(2, Math.min(20, Number(cfg.tailTurns) || DEFAULT_TAIL_TURNS)),
    maxAgeMs: Math.max(60_000, Number(cfg.maxAgeMs) || 24 * 3600 * 1000),
  }
}

// ---------- 路径 ----------
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
export function projCacheDir(home = dshHome()) {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}
export function sessionsRoot(home = dshHome()) {
  return path.join(home, 'sessions')
}
export function statePathOf(workspace) {
  return path.join(workspace, '.dsh-semantic', 'relay-state.json')
}

/** 在 <DSH_HOME>/sessions/<编码工作区>/<sid>/ 里找某个会话的日志文件（不依赖目录编码规则，直接遍历）。 */
export function findSessionLog(home, sid) {
  const root = sessionsRoot(home)
  let buckets = []
  try { buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return null }
  for (const b of buckets) {
    const dir = path.join(root, b.name, sid)
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// ---------- zstd 多帧读取 ----------
/** 扫描 zstd 帧头；v3 日志是 N 个独立帧拼接，单帧解压只能拿到第一帧。 */
export function frameOffsets(buf) {
  const offs = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offs.push(i)
  }
  return offs
}

/** 只解最后 frames 帧（帧与行边界可能错位，故丢掉首行）。 */
export function readTailLines(file, frames = DEFAULT_FRAMES) {
  const buf = fs.readFileSync(file)
  const offs = frameOffsets(buf)
  if (offs.length === 0) return []
  const use = offs.slice(-frames)
  let text = ''
  for (const o of use) {
    try { text += zlib.zstdDecompressSync(buf.subarray(o)).toString('utf8') } catch { /* 尾部可能写入中：跳过该帧 */ }
  }
  const lines = text.split('\n').filter(Boolean)
  if (use[0] !== 0 && lines.length > 0) lines.shift() // 首行可能是半行
  return lines
}

/** 从事件行里抽"人说的话"：真实用户消息 + 助手正文（跳过 reasoning/tool）。 */
export function extractDialogue(lines, limit) {
  const out = []
  for (const line of lines) {
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    if (evt?.type === 'user/message') {
      const src = evt.data?.source
      if (src && src.kind && src.kind !== 'user') continue // 只认真实用户输入
      const text = textOf(evt.data?.content)
      if (text) out.push({ role: 'user', text })
    } else if (evt?.type === 'assistant/message') {
      const text = textOf(evt.data?.message?.content)
      if (text) out.push({ role: 'assistant', text })
    }
  }
  return limit ? out.slice(-limit) : out
}
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

// ---------- 找"上一个会话" ----------
/** 按**会话日志文件**的最后写入时间找最近活跃的非当前主会话。
 *  不能用投影缓存的 mtime —— dream 巡检也会刷新它，会把"最近活跃"带偏
 *  （实测：一个 09-15 的老会话被巡检后 projcache 时间跳到了今天）。
 *  只考虑 `session-` 前缀的主会话；子代理会话（裸 UUID）不参与接力。 */
export function pickPreviousSession(home, currentSid, maxAgeMs) {
  const root = sessionsRoot(home)
  let buckets = []
  try { buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return null }
  let best = null
  for (const b of buckets) {
    let sids = []
    try { sids = fs.readdirSync(path.join(root, b.name), { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const s of sids) {
      if (s.name === currentSid || !s.name.startsWith('session-')) continue
      const dir = path.join(root, b.name, s.name)
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        try {
          const p = path.join(dir, name)
          const st = fs.statSync(p)
          if (Date.now() - st.mtimeMs > maxAgeMs) break
          if (!best || st.mtimeMs > best.mtime) best = { sid: s.name, mtime: st.mtimeMs, log: p }
          break
        } catch { /* 试下一个候选文件名 */ }
      }
    }
  }
  return best
}

/** 读投影缓存拿标题 + 首条用户原话（80KB 级，但只取需要的字段）。 */
export function readSessionMeta(home, sid) {
  try {
    const raw = fs.readFileSync(path.join(projCacheDir(home), `${sid}.json`), 'utf8')
    const j = JSON.parse(raw)
    const rows = j?.record?.rows || {}
    const title = rows.title?.val || ''
    const first = rows.titleInput?.val?.first?.text || ''
    return { title: String(title), first: String(first).replace(/\s+/g, ' ').slice(0, 200) }
  } catch { return { title: '', first: '' } }
}

/** 抽尾部对话；若解出的**用户消息太少**就多解几帧重试 ——
 *  接力块里没有"维护者说了什么"就基本没用（实测只解 12 帧时抽到的可能全是助手的收尾话）。
 *
 * 2026-09-24 修（真机暴露：他换会话时接力块里一条他的话都没有）：
 * 原来的自适应写成 `if (more.length <= dlg.length) break`，而 `dlg` 已被 `tailTurns` 截成
 * 固定条数——多解帧也不会变长，于是窗口永远不再扩大。现在分两步：
 *  ① 先用**宽窗口**抽（tailTurns × 6），再收敛成"**尽量 tailTurns 条、但至少含 minUsers 条用户发言**"；
 *  ② 循环条件改成比较**用户消息条数**是否真的增加。
 * 向后兼容：尾部本来就有足够用户发言时，结果与旧实现逐字相同。
 */
export function tailWithUsers(dialogue, tailTurns, minUsers = 2) {
  const list = Array.isArray(dialogue) ? dialogue : []
  const userCount = (items) => items.filter((d) => d.role === 'user').length
  if (list.length <= tailTurns) return list
  let start = list.length - tailTurns
  while (start > 0 && userCount(list.slice(start)) < minUsers) start -= 1
  return list.slice(start)
}

export function extractWithUsers(log, cfg) {
  const minUsers = 2
  const wide = () => cfg.tailTurns * 6
  const users = (items) => items.filter((d) => d.role === 'user').length
  let frames = cfg.frames
  let dlg = tailWithUsers(extractDialogue(readTailLines(log, frames), wide()), cfg.tailTurns, minUsers)
  for (let i = 0; i < 3 && users(dlg) < minUsers; i++) {
    frames = Math.min(frames * 3, 240)
    const more = tailWithUsers(extractDialogue(readTailLines(log, frames), wide()), cfg.tailTurns, minUsers)
    if (users(more) <= users(dlg)) break
    dlg = more
  }
  return dlg
}

// ---------- 组装注入正文 ----------
function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
/**
 * 时间显示：**固定北京时间**（不是本机时间）。
 *
 * 2026-10-08 复核（差点改错，记录事实免得下次又有人"修"它）：
 *   本机的系统时区其实是 **UTC+9（东京）**，维护者按北京时间说话 —— 所以本机
 *   `toLocaleString()` 显示 05:11 时，北京时间是 04:11，旧的
 *   `new Date(ms + 8*3600*1000).toISOString()` 算出来的正是 04:11，**是对的**。
 *   （我先前误判成"多加了一小时"，用 toLocaleString 对比才看清 offset=-540 是东京。）
 *
 * 现在改用运行时按 Asia/Shanghai 渲染：语义与旧实现逐字一致（都是北京墙上时间），
 * 但不再依赖"机器偏移恰好是 +8"这个隐含前提，也不必再手算毫秒。导出供自测断言。
 */
function hm(ms) {
  try {
    const d = new Date(Number(ms))
    if (Number.isNaN(d.getTime())) return '?'
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).replace(/\//g, '-') + '（北京）'
  } catch { return '?' }
}

export function buildRelayText(currentSid, prev, dialogue, cfg) {
  const head = [
    `【接力上下文 · ${PLUGIN}】`,
    `你在新会话里提到了"继续"，以下是**上一个会话**的尾巴，用于接上话题（不是你这次的指令）：`,
    `· 上个会话：《${prev.title || '(无题)'}》｜最后活跃 ${hm(prev.mtime)}｜id ${String(prev.sid).slice(0, 20)}`,
  ]
  if (prev.first) head.push(`· 它开头第一句：${clip(prev.first, 160)}`)
  const body = []
  if (dialogue.length > 0) {
    body.push('· 最近的对话：')
    for (const d of dialogue) {
      body.push(`  ${d.role === 'user' ? '用户' : '助手'}：${clip(d.text, 300)}`)
    }
  }
  const tail = '（如需全文，用会话 id 去 ~/.dsh/sessions/ 里翻；若这不是你要接的话题，忽略本块。）'
  const lines = [...head, ...body]
  // 硬上限：从后往前保留最近的内容
  let text = lines.join('\n')
  if (text.length > cfg.maxChars) {
    const keep = []
    let used = head.join('\n').length + tail.length + 40
    for (let i = body.length - 1; i >= 0; i--) {
      if (used + body[i].length > cfg.maxChars) break
      keep.unshift(body[i]); used += body[i].length + 1
    }
    text = [...head, ...keep].join('\n')
  }
  return `${text}\n${tail}`
}

// ---------- 状态（已注入标记 + 抽取缓存） ----------
function readState(workspace) {
  try { return JSON.parse(fs.readFileSync(statePathOf(workspace), 'utf8')) } catch { return { injected: {}, cache: {} } }
}
function writeState(workspace, state) {
  try {
    const p = statePathOf(workspace)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // 缓存别无限长：只留最近 8 条
    const cacheKeys = Object.keys(state.cache || {})
    if (cacheKeys.length > 8) {
      for (const k of cacheKeys.slice(0, cacheKeys.length - 8)) delete state.cache[k]
    }
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8')
  } catch { /* 状态写不进去也不影响对话 */ }
}

// ---------- 注入消息 ----------
let msgFactoryPromise = null
function loadMsgFactory() {
  if (!msgFactoryPromise) {
    msgFactoryPromise = import('@deepseek-ai/dsh-llm')
      .then((m) => (typeof m.createUserMessage === 'function' ? m.createUserMessage : null))
      .catch(() => null)
  }
  return msgFactoryPromise
}
async function makeRelayMessage(text) {
  const content = [{ type: 'text', text }]
  const source = await injectionSource(PLUGIN, '跨会话接力：上个会话的上下文')
  const factory = await loadMsgFactory()
  if (factory) {
    try { return factory({ content, source }) } catch { /* 降级 */ }
  }
  return {
    id: `mem-relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    source,
  }
}

// ---------- 注册 ----------
/**
 * 注册跨会话接力。依赖由 index.js 注入。
 * @param ctx Cordis 上下文
 * @param deps {{ logger, config }}
 */
export function registerSessionRelay(ctx, deps) {
  const { logger, config } = deps
  const cfg = normalizeRelayConfig(config)
  if (!cfg) {
    logger && logger.info(`${PLUGIN}: session relay off (disabled by config)`)
    return
  }
  const attempted = new Set() // 本进程内：每个会话只试一次

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'enter') return decision
      if (decision.messages.length === 0) return decision
      if (!agent || signal?.aborted) return decision
      const header = agent.session?.header || {}
      if (header.origin === 'subagent') return decision // 子代理不注入
      const sid = String(header.id || header.sessionId || '')
      const workspace = header.cwd
      if (!sid || !workspace) return decision
      if (attempted.has(sid)) return decision

      // 只在本会话前几轮尝试；且只认真实用户消息
      const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user')
      if (userMsgs.length === 0) return decision
      const lastUser = userMsgs[userMsgs.length - 1]
      const userText = textOf(lastUser.content)
      // 没命中触发词时**不能**标记已尝试 —— 他完全可能第一句是「你好」、第二句才说「继续」
      if (!userText || !cfg.trigger.test(userText)) return decision

      // 轮次闸门：数一数这个会话里已经有多少条用户消息
      const turn = countUserTurns(agent.session)
      if (turn > cfg.maxTurns) { attempted.add(sid); return decision }

      const home = dshHome()
      const prev = pickPreviousSession(home, sid, cfg.maxAgeMs)
      if (!prev) { attempted.add(sid); return decision }
      const meta = readSessionMeta(home, prev.sid)

      // 抽取（带缓存）
      const state = readState(workspace)
      let dialogue = state.cache?.[prev.sid]?.dialogue
      if (!Array.isArray(dialogue)) {
        const log = prev.log || findSessionLog(home, prev.sid)
        dialogue = log ? extractWithUsers(log, cfg) : []
        state.cache = state.cache || {}
        state.cache[prev.sid] = { at: Date.now(), dialogue }
      }

      const text = buildRelayText(sid, { ...prev, ...meta }, dialogue, cfg)
      const message = await makeRelayMessage(text)
      if (!message) { attempted.add(sid); return decision }

      attempted.add(sid)
      state.injected = state.injected || {}
      state.injected[sid] = { at: Date.now(), from: prev.sid }
      writeState(workspace, state)

      logger && logger.info(`${PLUGIN}: session relay 注入 ${text.length} 字符（${sid.slice(0, 12)} ← ${prev.sid.slice(0, 12)}，对话 ${dialogue.length} 条）`)
      const rewritten = [...decision.messages]
      rewritten.splice(rewritten.indexOf(lastUser), 0, message)
      return { ...decision, messages: rewritten }
    } catch (error) {
      logger && logger.warn && logger.warn(`${PLUGIN}: session relay 失败（已忽略）：${(error && error.message) || error}`)
      return decision
    }
  })

  logger && logger.info(`${PLUGIN}: session relay on（触发词 ${cfg.trigger}，上限 ${cfg.maxChars} 字符，只在前 ${cfg.maxTurns} 轮）`)
}

/** 数会话日志里已有的真实用户消息条数（判断"这是不是新会话的前几轮"）。 */
export function countUserTurns(session) {
  try {
    const events = typeof session?.events === 'function' ? session.events() : null
    if (Array.isArray(events)) {
      let n = 0
      for (const e of events) {
        if (e?.type === 'user/message' && (!e.data?.source?.kind || e.data.source.kind === 'user')) n++
      }
      return n
    }
  } catch { /* 落到兜底 */ }
  return 1
}

export { DEFAULT_TRIGGER, hm }
