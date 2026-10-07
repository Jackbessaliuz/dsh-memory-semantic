/**
 * ollama.js —— 本地嵌入引擎（bge-m3）的探测、拉起与健康检查
 *
 * 为什么单独一个文件：Ollama 不是 DSH 的依赖，而是"有则更好"的外部服务。
 * 它可能没装、没跑、装在奇怪的位置、或者用户根本不想让它常驻内存。
 * 这里把这三件事分开处理：
 *   1. **探测**（永远做，超时 800ms）——在跑就用向量；
 *   2. **拉起**（仅当 autoStart=true，且探测失败）——**不阻塞本次调用**，
 *      丢后台点火，本次照常走 BM25（"点火不等人"，2026-10-07 维护者拍板）；
 *   3. **降级**（一切失败都静默）——插件的任何功能都不因为 Ollama 不在而失败。
 *
 * 跨平台探测链：显式路径 → PATH → 各平台默认安装位置。
 * 开源取舍：默认 autoStart=false（不擅自启动别人机器上的服务）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

/** PATH 里找可执行文件（不依赖 where/which，避免 shell 差异）。 */
function findInPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name)
      try { if (fs.statSync(p).isFile()) return p } catch { /* 下一个 */ }
    }
  }
  return null
}

/** 各平台默认安装位置（按"优先带界面的启动器"排序）。 */
function platformCandidates() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    return [
      path.join(local, 'Programs', 'Ollama', 'ollama app.exe'),
      path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(pf, 'Ollama', 'ollama.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/Applications/Ollama.app/Contents/MacOS/Ollama',
      path.join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
    ]
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/ollama/bin/ollama', path.join(home, '.local', 'bin', 'ollama')]
}

/**
 * 解析拉起命令。返回 { cmd, args, kind } 或 null。
 * Windows 优先 `ollama app.exe`（用户熟悉的托盘形态），退而用 `ollama serve`。
 */
export function resolveOllamaCommand(cfg) {
  const explicit = cfg?.executablePath
  if (explicit) {
    if (fs.existsSync(explicit)) return { cmd: explicit, args: [], kind: 'config' }
    return null // 用户指定了却不存在：不要偷偷回落到别的路径
  }
  // 先看平台默认位置：Windows 上优先带托盘的 `ollama app.exe`
  // （用户能看见它在跑、也知道怎么退出；`ollama serve` 是无界面的，装了反而让人找不到）
  for (const p of platformCandidates()) {
    if (fs.existsSync(p)) {
      const isApp = /ollama app\.exe$/i.test(p)
      return { cmd: p, args: isApp ? [] : ['serve'], kind: 'default' }
    }
  }
  // 再退到 PATH
  const names = process.platform === 'win32' ? ['ollama.exe'] : ['ollama']
  const inPath = findInPath(names)
  if (inPath) return { cmd: inPath, args: ['serve'], kind: 'path' }
  return null
}

/** 健康探测：能否连上、模型在不在。任何异常都当作"不可用"。 */
export async function probeOllama(cfg, fetchImpl = fetch) {
  const base = String(cfg?.url || '').replace(/\/+$/, '')
  const model = String(cfg?.model || 'bge-m3')
  try {
    const r = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(cfg?.probeTimeoutMs ?? 800) })
    if (!r.ok) return false
    const j = await r.json()
    return Array.isArray(j.models) && j.models.some((m) => String(m?.name || '').startsWith(model))
  } catch {
    return false
  }
}

/** 后台点火：spawn 后立刻脱手（detached + stdio ignore + unref），绝不阻塞调用方。 */
export function startOllama(cfg, logger) {
  const found = resolveOllamaCommand(cfg)
  if (!found) {
    logger?.warn?.('[dsh-memory-semantic] 找不到 ollama 可执行文件，无法主动拉起（可配 ollama.executablePath）')
    return { started: false, reason: 'not-found' }
  }
  try {
    const child = spawn(found.cmd, found.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    logger?.info?.(`[dsh-memory-semantic] 已在后台拉起 Ollama（${found.kind}: ${found.cmd}）`)
    return { started: true, cmd: found.cmd, kind: found.kind }
  } catch (e) {
    logger?.warn?.(`[dsh-memory-semantic] 拉起 Ollama 失败：${(e && e.message) || e}`)
    return { started: false, reason: 'spawn-failed', error: String((e && e.message) || e) }
  }
}

/**
 * 组合动作：探测 →（可选）拉起 →（可选）短暂等待。
 *
 * @returns {Promise<{ ok: boolean, started: boolean, waited: boolean, reason?: string }>}
 *  - ok=true        ：可以走向量
 *  - ok=false, started=true ：已后台点火，本次请降级为 BM25（下次可能可用）
 *  - ok=false, started=false：没装/没找到，静默降级
 */
export async function ensureOllama(cfg, logger, fetchImpl = fetch) {
  if (await probeOllama(cfg, fetchImpl)) return { ok: true, started: false, waited: false }
  if (!cfg?.autoStart) return { ok: false, started: false, waited: false, reason: 'autostart-off' }

  const spawnResult = startOllama(cfg, logger)
  const waitMs = Number(cfg?.warmupWaitMs) || 0
  if (!spawnResult.started || waitMs <= 0) {
    return { ok: false, started: spawnResult.started, waited: false, reason: spawnResult.reason || 'warming-up' }
  }
  // 愿意等的用户：按 250ms 步长轮询，最多 warmupWaitMs
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 250))
    if (await probeOllama(cfg, fetchImpl)) return { ok: true, started: true, waited: true }
  }
  return { ok: false, started: true, waited: true, reason: 'warmup-timeout' }
}
