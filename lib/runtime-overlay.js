/**
 * runtime-overlay —— 设置页"能动手"的那部分状态（2026-10-08）
 *
 * 为什么需要它：设置页原先纯只读——用户在界面上看得见却够不着（维护者原话：
 * 「全都不能交互，我也不能切换自动拉起的开关」）。但**不是所有旋钮都能就地改**：
 * 改宿主 profile 需要重启、写坏会让宿主起不来（见压缩档位那块的"只给片段"决定）。
 *
 * 所以这里只放一类：**改了即时生效、且与宿主无关**的运行时开关。落盘在插件自己的
 * 机器级覆盖文件里，优先级 覆盖文件 ＞ profile config ＞ 内置默认。
 *
 * 纪律：
 *  - **白名单**：界面能写什么必须在这里列全，绝不透传任意字段（防把配置注入当接口）；
 *  - **坏文件不致命**：读失败/JSON 损坏一律当"没有覆盖"，绝不让插件起不来；
 *  - 只写插件自己的文件，绝不碰 ~/.dsh/profiles/**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 覆盖文件（机器级：同一台机器的多个 profile 共用一份开关）。 */
export const OVERLAY_FILE = 'dsh-memory-semantic.runtime.json'

/**
 * 可从界面写入的键 → 期望类型。
 * 只收"即时生效、零宿主风险"的旋钮；需要写 profile patch 的一律不在这里。
 */
export const WRITABLE = {
  'ollama.autoStart': 'boolean',
}

export function overlayFile(home) {
  const root = home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(root, OVERLAY_FILE)
}

/** 读覆盖（不存在 / 损坏 / 不是对象 → 空覆盖，绝不抛）。 */
export function readOverlay(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(overlayFile(home), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** 收集对象里所有叶子路径（如 'ollama.autoStart'）。 */
function leafPaths(node, prefix = '', out = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    if (prefix) out.push(prefix)
    return out
  }
  for (const [k, v] of Object.entries(node)) leafPaths(v, prefix ? prefix + '.' + k : k, out)
  return out
}

/** 按白名单校验请求体：白名单外的字段一律拒绝（不做静默忽略）。 */
export function validatePatch(patch) {
  const errors = []
  const value = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['请求体必须是 JSON 对象'], value: {} }
  }
  const allowed = new Set(Object.keys(WRITABLE))
  for (const key of leafPaths(patch)) {
    if (!allowed.has(key)) errors.push('不可写的字段：' + key + '（可写：' + [...allowed].join('、') + '）')
  }
  if (errors.length) return { ok: false, errors, value: {} }
  const seen = new Set()
  for (const [key, want] of Object.entries(WRITABLE)) {
    const parts = key.split('.')
    let cur = patch
    for (const p of parts) {
      if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p]
      else { cur = undefined; break }
    }
    if (cur === undefined) continue
    seen.add(key)
    if (want === 'boolean' && typeof cur !== 'boolean') {
      errors.push(key + ' 必须是 true / false')
      continue
    }
    let node = value
    for (let i = 0; i < parts.length - 1; i += 1) {
      node[parts[i]] = node[parts[i]] && typeof node[parts[i]] === 'object' ? node[parts[i]] : {}
      node = node[parts[i]]
    }
    node[parts[parts.length - 1]] = cur
  }
  if (!seen.size && !errors.length) {
    errors.push('没有可写的字段（白名单：' + Object.keys(WRITABLE).join('、') + '）')
  }
  return { ok: errors.length === 0, errors, value }
}

function deepMerge(base, patch) {
  const out = { ...(base && typeof base === 'object' ? base : {}) }
  for (const [k, v] of Object.entries(patch || {})) {
    const b = out[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? deepMerge(b, v)
      : v
  }
  return out
}

/** 校验 → 合并 → 落盘。返回 { ok, file?, value?, overlay?, errors? }。 */
export function writeOverlay(patch, home) {
  const check = validatePatch(patch)
  if (!check.ok) return { ok: false, errors: check.errors }
  const file = overlayFile(home)
  const next = deepMerge(readOverlay(home), check.value)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (e) {
    return { ok: false, errors: ['写入失败：' + ((e && e.message) || String(e))] }
  }
  return { ok: true, file, value: check.value, overlay: next }
}

/**
 * 把覆盖并进 cfg（就地改，cfg 是插件各处共用的同一个对象）。
 * 只处理白名单键；覆盖里多余的键一律忽略。
 */
export function applyOverlay(cfg, overlay) {
  if (!cfg || !cfg.ollama) return cfg
  const o = overlay && typeof overlay === 'object' ? overlay : {}
  const a = o.ollama && typeof o.ollama === 'object' ? o.ollama.autoStart : undefined
  if (typeof a === 'boolean') cfg.ollama.autoStart = a
  return cfg
}

export default { OVERLAY_FILE, WRITABLE, overlayFile, readOverlay, validatePatch, writeOverlay, applyOverlay }
