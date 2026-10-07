/**
 * session-log —— DSH v3 会话日志读取（只读）
 *
 * v3 日志是**多帧 zstd**拼接（一次 flush 一帧），一次性解压只会拿到第一帧。
 * 做法：扫帧魔数 28 B5 2F FD 切帧 → 逐帧 zstdDecompressSync → 按行 JSON.parse。
 *
 * 第 1 行是会话 header（type:'session'），其后每个事件自带 `seq` 且从 0 连续；
 * 丢掉 header 后数组下标即 seq —— 这正是 foldSurface / 轮次记忆所依赖的稳定身份。
 *
 * 本模块不写任何 DSH 数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 扫出所有帧起始偏移（数据体里偶发的魔数由"解压失败即跳过"兜住）。 */
export function frameOffsets(buf) {
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offs.push(i)
  }
  return offs
}

/** 解压日志文本；frames 为 null 时解全部帧，否则只解最后 N 帧。 */
export function readLogText(file, options = {}) {
  const buf = fs.readFileSync(file)
  const offs = frameOffsets(buf)
  if (offs.length === 0) return { text: '', frames: 0, bytes: buf.length }
  const use = options.frames ? offs.slice(-Math.max(1, options.frames)) : offs
  let text = ''
  let okFrames = 0
  for (const off of use) {
    const idx = offs.indexOf(off)
    const end = idx + 1 < offs.length ? offs[idx + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(off, end)).toString('utf8')
      okFrames += 1
    } catch { /* 写入中的尾帧或假魔数：跳过 */ }
  }
  return { text, frames: okFrames, bytes: buf.length }
}

/**
 * 读成一个事件数组（丢掉 header）。
 * @returns { header, events, frames, bytes, unparsed, seqContiguous }
 */
export function readSessionEvents(file, options = {}) {
  const { text, frames, bytes } = readLogText(file, options)
  const raw = []
  let unparsed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { raw.push(JSON.parse(line)) } catch { unparsed += 1 }
  }
  const header = raw.find((e) => e?.type === 'session') ?? null
  const events = raw.filter((e) => e?.type !== 'session')
  let seqContiguous = true
  for (const [i, e] of events.entries()) if (e.seq !== i) { seqContiguous = false; break }
  return { header, events, frames, bytes, unparsed, seqContiguous }
}

/** DSH_HOME（会话目录的根）。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 在 <DSH_HOME>/sessions/<编码工作区>/<sid>/ 下找会话日志（不依赖目录编码规则）。 */
export function findSessionLog(sid, home = dshHome()) {
  const root = path.join(home, 'sessions')
  let buckets = []
  try { buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return null }
  for (const bucket of buckets) {
    const dir = path.join(root, bucket.name, sid)
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}
