/**
 * ollama 自测：探测三态 / 命令解析（显式路径优先且不回退）/ 拉起分支 / 组合语义
 * 跑法：node scripts/self-test-ollama.mjs
 * 注意：不真的启动 Ollama（用 where.exe 之类一次性进程代替）。
 */
import assert from 'node:assert'
import { resolveOllamaCommand, probeOllama, startOllama, ensureOllama } from '../lib/ollama.js'

const base = { url: 'http://127.0.0.1:11434', model: 'bge-m3', probeTimeoutMs: 100, autoStart: false, warmupWaitMs: 0 }
const fakeOk = async () => ({ ok: true, json: async () => ({ models: [{ name: 'bge-m3:latest' }] }) })
const fakeNoModel = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3:8b' }] }) })
const fakeThrow = async () => { throw new Error('ECONNREFUSED') }
const fakeBad = async () => ({ ok: false, json: async () => ({}) })
const quiet = { info: () => {}, warn: () => {} }

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass += 1 } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}

await t('探测：模型在 → true', async () => assert.equal(await probeOllama(base, fakeOk), true))
await t('探测：模型不在 → false', async () => assert.equal(await probeOllama(base, fakeNoModel), false))
await t('探测：连不上 → false（不抛错）', async () => assert.equal(await probeOllama(base, fakeThrow), false))
await t('探测：HTTP 非 2xx → false', async () => assert.equal(await probeOllama(base, fakeBad), false))

await t('命令解析：显式路径不存在 → null（不偷偷回落）', () => {
  assert.equal(resolveOllamaCommand({ ...base, executablePath: 'Z:\\nope\\ollama.exe' }), null)
})
await t('命令解析：显式路径存在 → kind=config', () => {
  const r = resolveOllamaCommand({ ...base, executablePath: 'C:\\Windows\\System32\\where.exe' })
  assert.equal(r.kind, 'config')
  assert.deepEqual(r.args, [])
})
await t('命令解析：本机默认安装位置能找到（Windows 优先 app.exe）', () => {
  const r = resolveOllamaCommand({ ...base, executablePath: '' })
  if (process.platform === 'win32') {
    assert.ok(r, '未找到 ollama（PATH 与默认位置都没有），请确认已安装')
    assert.ok(r.kind === 'default' || r.kind === 'path', `意外的来源：${r.kind}`)
    console.log(`     （实测：kind=${r.kind} cmd=${r.cmd} args=[${r.args.join(' ')}]）`)
  }
})

await t('拉起：找不到可执行文件 → started=false / not-found', () => {
  const r = startOllama({ ...base, executablePath: 'Z:\\nope\\ollama.exe' }, quiet)
  assert.equal(r.started, false)
  assert.equal(r.reason, 'not-found')
})
await t('拉起：可执行文件存在 → 真 spawn 且立刻脱手', () => {
  const r = startOllama({ ...base, executablePath: 'C:\\Windows\\System32\\where.exe' }, quiet)
  assert.equal(r.started, true)
})

await t('ensureOllama：探测成功 → ok=true，不拉起', async () => {
  const r = await ensureOllama(base, quiet, fakeOk)
  assert.equal(r.ok, true)
  assert.equal(r.started, false)
})
await t('ensureOllama：探测失败且 autoStart=false → 静默降级', async () => {
  const r = await ensureOllama({ ...base, autoStart: false }, quiet, fakeThrow)
  assert.equal(r.ok, false)
  assert.equal(r.started, false)
  assert.equal(r.reason, 'autostart-off')
})
await t('ensureOllama：autoStart=true + warmupWaitMs=0 → 点火但不等待（本次仍降级）', async () => {
  const r = await ensureOllama({ ...base, autoStart: true, warmupWaitMs: 0, executablePath: 'C:\\Windows\\System32\\where.exe' }, quiet, fakeThrow)
  assert.equal(r.ok, false)
  assert.equal(r.started, true)
  assert.equal(r.waited, false)
})
await t('ensureOllama：autoStart=true + 会等待 → 等待期间探测成功即用向量', async () => {
  let calls = 0
  const soonOk = async () => { calls += 1; return calls > 1 ? fakeOk() : fakeThrow() }
  const r = await ensureOllama({ ...base, autoStart: true, warmupWaitMs: 2000, executablePath: 'C:\\Windows\\System32\\where.exe' }, quiet, soonOk)
  assert.equal(r.ok, true)
  assert.equal(r.waited, true)
})

console.log(`\nollama 自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
