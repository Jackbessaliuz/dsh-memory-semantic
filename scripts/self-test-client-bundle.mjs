/**
 * client bundle 自测：把 lib/client.js 放进"假浏览器"里真跑一遍。
 *
 * 为什么必须有这个自测（2026-10-08 事故）：
 *   bundle 里漏了 `var module = { exports: {} }` + `var exports = module.exports`
 *   两行 → 末尾 `return module.exports` 抛
 *   `TypeError: Cannot read properties of undefined (reading 'exports')`
 *   → 浏览器里整个 client 插件加载失败、「语义记忆」设置页从未注册；
 *   而 host 半侧照旧正常，`node --check` 也只查语法（这行是合法的运行时错误），
 *   所以**只有真跑一遍 factory 才拦得住**。
 *
 * 跑法：node scripts/self-test-client-bundle.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')
const source = fs.readFileSync(bundlePath, 'utf8')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`) } catch (e) { fail += 1; console.log(`  ✗ ${name}\n     ${e.message}`) }
}

/** 把 bundle 放进一个最小假浏览器，返回 __ModuleLoader__.load 收到的 entry */
function loadBundle() {
  let entry = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } },
    console,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('自测里不发真请求')),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    // 故意**不**提供 document：ensureCss() 必须自己扛住
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  return entry
}

const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  Fragment: 'Fragment',
}

/* ── 1. 形态：能真跑出 entry，id 与包名一致 ─────────────────────── */
let entry = null
t('bundle 能加载并交出 entry', () => {
  entry = loadBundle()
  assert.ok(entry, '未调用 window.__ModuleLoader__.load')
  assert.equal(entry.id, 'dsh-memory-semantic', 'id 必须等于包名')
  assert.equal(typeof entry.factory, 'function')
})

/* ── 2. 红线：factory 内自带 module/exports 声明 ─────────────────── */
t('factory 内声明了 module 与 exports（本次事故根因）', () => {
  assert.match(source, /\bvar module = \{ exports: \{\} \}/, '缺少 var module = { exports: {} }')
  assert.match(source, /\bvar exports = module\.exports/, '缺少 var exports = module.exports')
})

/* ── 3. 真跑 factory：不得抛错、必须返回插件面 ──────────────────── */
let plugin = null
t('factory(require) 不抛错并返回插件面', () => {
  plugin = entry.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`意外依赖 ${id}`)
  })
  assert.ok(plugin, 'factory 返回空（多半又是 module/exports 没声明）')
  assert.equal(plugin.name, 'dsh-memory-semantic')
  assert.deepEqual([...plugin.inject], ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

/* ── 4. apply：注册到 settings.section / memory-semantic / order 36 ── */
t('apply 把「语义记忆」注册进 settings.section（order 36）', () => {
  const registered = []
  let injectedKey = null
  const ctx = {
    slots: {
      inject(key, cb) {
        injectedKey = key
        // 模拟 loader：注入声明存活时立刻展开一次
        const gen = cb()
        if (gen && typeof gen.next === 'function') { let r = gen.next(); while (!r.done) r = gen.next() }
      },
      register(options, component) { registered.push({ options, component }) },
    },
  }
  plugin.apply(ctx)
  assert.equal(injectedKey, 'settings.section', '注入的 ownerKey 必须是 settings.section')
  assert.equal(registered.length, 1, '应恰好注册一项')
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'memory-semantic')
  assert.equal(registered[0].options.order, 36)
  assert.equal(registered[0].options.label, '语义记忆')
  assert.equal(typeof registered[0].component, 'function', '注册的必须是组件函数')
})

/* ── 5. 组件能直接调用（render 期不抛） ─────────────────────────── */
t('组件函数可直接调用（无 document 环境下也不炸）', () => {
  const registered = []
  const ctx = {
    slots: {
      inject: (key, cb) => { const g = cb(); let r = g.next(); while (!r.done) r = g.next() },
      register: (options, component) => registered.push({ options, component }),
    },
  }
  plugin.apply(ctx)
  const out = registered[0].component({})
  assert.ok(out, '组件返回空')
  assert.equal(out.type, 'div')
})

/* ── 6. 反面样本：漏声明的写法必须被本自测抓住 ───────────────────── */
t('反面样本（删掉 module/exports 声明）确实在 factory 里抛错', () => {
  const broken = source
    .replace(/\s*var module = \{ exports: \{\} \}/, '')
    .replace(/\s*var exports = module\.exports/, '')
  assert.notEqual(broken, source, '替换没生效，反面样本无效')
  let entry2 = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (v) => { entry2 = v } } },
    console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('x')),
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(broken, sandbox, { filename: 'broken-client.js' })
  // 实测（2026-10-08）：漏声明时崩在 factory 体末尾的 `exports.apply = apply`
  // —— ReferenceError: exports is not defined；若只漏 module 一行，则崩在
  // `return module.exports` —— TypeError。两种都算被抓住。
  // 注意：vm 里抛出的错误不属于本 realm 的 ReferenceError，instanceof 会判 false，
  // 所以按 name + message 判，不按原型链判。
  assert.throws(
    () => entry2.factory(() => reactStub),
    (e) => (e && e.name === 'ReferenceError' && /exports/.test(e.message)) ||
           (e && e.name === 'TypeError' && /module/.test(e.message)),
    '漏声明本该抛错（ReferenceError: exports / TypeError: module）',
  )
})

console.log(`\nclient bundle 自测：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
