/**
 * host-scan —— 给设置页用的"宿主侧体检"（**只读，不写任何宿主文件**）
 *
 * 两件事：
 *  1. `readHostCompaction()`：读宿主 profile 的 `cordis.patch.yml`，看 `compaction-basic`
 *     到底配了什么（我们 patch 里通常什么都没配 = 全吃官方默认），并给出保守/标准/激进三档建议；
 *  2. `scanSessionPeaks()`：按体积解剖最近 N 个会话日志，取 `inputTokens` 峰值 —— 用来回答
 *     "你到底需不需要调压缩率"（峰值离 0.8×W 越远，越不需要）。
 *
 * 为什么不做"一键写入"：改宿主 profile 配置 = 改别人的组合，改错宿主起不来。
 * 这里只读 + 给可复制的片段，用户自己去改。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 官方默认（对齐 dsh-compaction-basic 2026-10 的文档）。 */
export const COMPACTION_DEFAULTS = {
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainRatio: 0.16,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  auto: true,
}

/**
 * 三档建议。
 * 口径：**保守 = 尽量不压**（压得更晚、保留更多原文）；激进 = 省上下文优先。
 * 注意官方校验要求 `retainRatio < thresholdRatio`，三档都满足。
 */
export const COMPACTION_PRESETS = [
  { id: 'conservative', label: '保守', hint: '压得更晚、保留更多原文（长会话更连贯，占上下文更多）', config: { thresholdRatio: 0.9, retainRatio: 0.25 } },
  { id: 'standard', label: '标准', hint: '官方默认，多数场景够用', config: { thresholdRatio: 0.8, retainRatio: 0.16 } },
  { id: 'aggressive', label: '激进', hint: '压得更早、保留更少（省上下文，老历史更快被摘要）', config: { thresholdRatio: 0.7, retainRatio: 0.1 } },
]

/** 生成"可直接粘进 profile patch"的 YAML 片段。 */
export function yamlSnippet(preset) {
  const c = preset && preset.config ? preset.config : COMPACTION_PRESETS[1].config
  return [
    '          - id: compaction-basic',
    "            name: '@deepseek-ai/dsh-compaction-basic'",
    '            config:',
    `              thresholdRatio: ${c.thresholdRatio}`,
    `              retainRatio: ${c.retainRatio}`,
  ].join('\n')
}

/** 列出所有 profile 的 cordis.patch.yml。 */
export function listProfilePatches(home = dshHome()) {
  const root = path.join(home, 'profiles')
  const out = []
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const p = path.join(root, d.name, 'cordis.patch.yml')
      if (fs.existsSync(p)) out.push({ profile: d.name, file: p })
    }
  } catch { /* 没有 profiles 目录 */ }
  return out
}

/** 从 patch 文本里抠 `compaction-basic` 的 config（简易行扫描，够这一处用）。 */
export function parseCompactionFromPatch(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/id:\s*compaction-basic/.test(lines[i])) continue
    const cfg = {}
    for (let j = i + 1; j < Math.min(lines.length, i + 24); j += 1) {
      const line = lines[j]
      if (/^\s*-\s*id:\s*/.test(line)) break // 到了下一个同级条目
      const m = /^\s*(thresholdRatio|headroomTokens|retainRatio|retainTokens|auto|compactionRetries|maxOverflowRetries|maxTokens|summarizationProvider|summarizationModel):\s*(\S+)\s*$/.exec(line)
      if (!m) continue
      const raw = m[2].replace(/^['"]|['"]$/g, '')
      cfg[m[1]] = /^(true|false)$/.test(raw) ? raw === 'true' : (Number.isFinite(Number(raw)) ? Number(raw) : raw)
    }
    found.push(cfg)
  }
  return found
}

/** 汇总：每个 profile 的压缩现状。`untouched=true` 表示 patch 里没配 = 全吃官方默认。 */
export function readHostCompaction(home = dshHome()) {
  const profiles = []
  for (const { profile, file } of listProfilePatches(home)) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const configs = parseCompactionFromPatch(text)
    const explicit = configs.find((c) => Object.keys(c).length > 0) || {}
    profiles.push({
      profile,
      file,
      explicit,
      effective: { ...COMPACTION_DEFAULTS, ...explicit },
      untouched: Object.keys(explicit).length === 0,
    })
  }
  return { defaults: COMPACTION_DEFAULTS, profiles, presets: COMPACTION_PRESETS }
}

/* ── 会话 token 峰值（按需触发，可能扫几秒） ─────────────────────── */

/** 扫出所有 zstd 帧起始偏移。 */
export function frameOffsets(buf) {
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offs.push(i)
  }
  return offs
}

/** 逐帧解压（只给"尾部若干字节"，首帧多为半帧 → 解压失败自然跳过）。 */
export function decompressFrames(buf) {
  const offs = frameOffsets(buf)
  const parts = []
  for (let k = 0; k < offs.length; k += 1) {
    const start = offs[k]
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')) } catch { /* 半帧/假魔数 */ }
  }
  return parts.join('')
}

function walkSessionLogs(dir, depth = 0, out = []) {
  if (depth > 3) return out
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkSessionLogs(p, depth + 1, out)
    else if (e.name === 'session.v4.jsonl.zstd' || e.name === 'session.v3.jsonl.zstd') out.push(p)
  }
  return out
}

/**
 * 按体积解剖最近 N 个会话，给出"上下文压力"的实测峰值。
 *
 * ⚠️ 口径（2026-10-08 在真实日志上定标，别再用旧写法）：
 *   usage 对象的真实形态是 {inputTokens, outputTokens, cacheReadTokens, reasoningTokens}，
 *   **cacheReadTokens 与 inputTokens 并列**（样本：inputTokens 240 / cacheReadTokens 16128）——
 *   即 **单次请求的总输入 = inputTokens + cacheReadTokens**。
 *   旧实现只取 inputTokens，**会系统性低估**上下文规模。
 *
 * 另外分两档报：普通请求的峰值 vs 压缩请求的峰值。压缩请求（compaction/summary）的输入
 * 就等于"压缩前那个会话涨到了多大"，正是"要不要调压缩率"最该看的数。
 *
 * @param {{ home?: string, limit?: number, tailBytes?: number }} options
 *   tailBytes：只读每个文件的尾部这么多字节（峰值通常在中后段，省时间）
 */
export function scanSessionPeaks(options = {}) {
  const home = options.home || dshHome()
  const limit = Number.isFinite(options.limit) ? options.limit : 5
  const tailBytes = Number.isFinite(options.tailBytes) ? options.tailBytes : 8 * 1024 * 1024
  const root = path.join(home, 'sessions')
  const files = walkSessionLogs(root).map((f) => {
    try { const st = fs.statSync(f); return { f, size: st.size, mtime: st.mtimeMs } } catch { return null }
  }).filter(Boolean).sort((a, b) => b.size - a.size).slice(0, limit)

  const rows = []
  for (const x of files) {
    let text = ''
    try {
      const fd = fs.openSync(x.f, 'r')
      const start = Math.max(0, x.size - tailBytes)
      const len = x.size - start
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      fs.closeSync(fd)
      text = decompressFrames(buf)
    } catch { /* 读失败就当没数据 */ }

    let compactionEvents = 0
    const normalTokens = []
    const compactionTokens = []
    for (const line of text.split('\n')) {
      if (!line) continue
      if (line.includes('"type":"compaction/start"')) compactionEvents += 1
      const isCompactionCall = line.includes('"type":"compaction/summary"')
      for (const m of line.matchAll(/"usage":\{([^}]*)\}/g)) {
        const seg = m[1]
        const inp = Number((/"inputTokens":(\d+)/.exec(seg) || [])[1]) || 0
        const cache = Number((/"cacheReadTokens":(\d+)/.exec(seg) || [])[1]) || 0
        const total = inp + cache
        if (!total) continue
        if (isCompactionCall) compactionTokens.push(total)
        else normalTokens.push(total)
      }
    }

    rows.push({
      sessionId: path.basename(path.dirname(x.f)),
      zipMB: Number((x.size / 1048576).toFixed(2)),
      scannedMB: Number((Math.min(tailBytes, x.size) / 1048576).toFixed(2)),
      samples: normalTokens.length + compactionTokens.length,
      peakInputTokens: normalTokens.length ? Math.max(...normalTokens) : 0,
      peakCompactionInputTokens: compactionTokens.length ? Math.max(...compactionTokens) : 0,
      compactionEvents,
      mtime: x.mtime,
    })
  }
  const peak = rows.reduce((m, r) => Math.max(m, r.peakInputTokens), 0)
  const peakCompaction = rows.reduce((m, r) => Math.max(m, r.peakCompactionInputTokens || 0), 0)
  const anyCompaction = rows.some((r) => r.compactionEvents > 0)
  return {
    scanned: rows.length,
    peakInputTokens: peak,
    peakCompactionInputTokens: peakCompaction,
    compactionSeen: anyCompaction,
    tokenBasis: '单次请求总输入 = inputTokens + cacheReadTokens',
    rows: rows.sort((a, b) => b.peakInputTokens - a.peakInputTokens),
    note: anyCompaction
      ? '扫描到的会话里出现过压缩事件 —— 「压缩时规模」就是压缩前该会话涨到的上下文大小'
      : '扫描到的会话里没有任何压缩事件 —— 说明还没到触发阈值',
  }
}
