/**
 * dsh-memory-semantic —— 客户端半侧（设置页「语义记忆」）
 *
 * 为什么要有这一半：插件原本是**纯 host**（工具 + 后台接线），用户在设置里
 * 看不到它、也够不着它的开关。这一半只做一件事——把 host 侧已经算好的
 * **只读状态**渲染成一页设置：引擎状态 / 索引与轮次 / 图谱 / 当前配置 /
 * 宿主压缩档位建议（给片段、可复制，**不代写**宿主配置）。
 *
 * 约定（红线，2026-10-02 定）：client bundle **必须**写成闭包工厂形态
 * `window.__ModuleLoader__.load({ id, factory })`，禁止裸脚本——同批次多个
 * bundle 会被拼进同一个 script 作用域，裸脚本的顶层声明会互相覆盖。
 * 顶层不得 import '@deepseek-ai/*'；本页只 require('react')。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-semantic',
  factory: function (require) {
    // 红线（与官方 bundle 同形）：factory 只拿到 require，module/exports 必须自己开。
    // 2026-10-08 事故：漏了这两行 → 末尾 `return module.exports` 抛
    // TypeError（Cannot read properties of undefined），整个 client 插件加载失败、
    // 「语义记忆」设置页从未注册，重启后表现为界面炸掉。官方 lib/client.js 与
    // 自研 dsh-md-bubble / dsh-market-expand / dsh-shot-render / dsh-meme / prts-terrarchive
    // 全部带这两行，只有本文件漏了。
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    /* ── 样式（与宿主设置页融合：低饱和边框、统一圆角、层级用 bg-layer-2） ── */
    var CSS_ID = 'dsh-memory-semantic-style'
    var CSS = [
      '.msem-page{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}',
      '.msem-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.msem-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(120,160,255,.16)}',
      '.msem-badge .dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.9}',
      '.msem-ok{color:#22c55e}', '.msem-warn{color:#f59e0b}', '.msem-muted{color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.msem-card{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));border:1px solid rgba(120,160,255,.16);border-radius:16px;padding:14px 16px}',
      '.msem-card h4{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#8b8b8b);text-transform:none}',
      '.msem-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;line-height:1.6}',
      '.msem-row .k{color:var(--dsw-alias-label-secondary,#8b8b8b);white-space:nowrap}',
      '.msem-row .v{text-align:right;word-break:break-all}',
      '.msem-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
      '.msem-preset{cursor:pointer;border-radius:10px;padding:10px 12px;border:1px solid rgba(120,160,255,.16);background:transparent;color:inherit;text-align:left;transition:background .15s,border-color .15s}',
      '.msem-preset:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}',
      '.msem-preset.on{border-color:var(--dsw-alias-brand-primary,#5b8cff);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}',
      '.msem-preset b{display:block;font-size:13px;margin-bottom:4px}',
      '.msem-preset span{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.msem-pre{margin:10px 0 0;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.22);color:#cfd6e4;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;overflow:auto;white-space:pre}',
      '.msem-actions{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}',
      '.msem-btn{border:1px solid rgba(120,160,255,.2);background:transparent;color:inherit;border-radius:18px;padding:6px 14px;font-size:12.5px;cursor:pointer;transition:opacity .15s,background .15s}',
      '.msem-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}',
      '.msem-btn[disabled]{opacity:.5;cursor:default}',
      '.msem-note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8b8b8b);margin-top:8px}',
      '.msem-err{color:#ef4444;font-size:12.5px}',
      '.msem-peaks{margin-top:10px;font-size:12px;line-height:1.7}',
      '.msem-toggle{cursor:pointer;background:transparent;font:inherit;transition:opacity .15s,border-color .15s}',
      '.msem-toggle:hover{border-color:var(--dsw-alias-brand-primary,#5b8cff)}',
      '.msem-toggle[disabled]{opacity:.55;cursor:default}',
      '.msem-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.msem-note code{padding:1px 5px;border-radius:5px;background:rgba(127,127,127,.14);font-family:ui-monospace,Consolas,monospace}',
    ].join('\n')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById(CSS_ID)) return
      var el = document.createElement('style')
      el.id = CSS_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    function get(url) {
      return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }

    function post(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.errors && j.errors.join('；')) || ('HTTP ' + r.status))
          return j
        })
      })
    }

    function fmtTime(ms) {
      if (!ms) return '—'
      try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) } catch (e) { return String(ms) }
    }
    function fmtNum(n) {
      return typeof n === 'number' ? n.toLocaleString('zh-CN') : String(n == null ? '—' : n)
    }

    function Row(k, v, cls) {
      return h('div', { className: 'msem-row' },
        h('span', { className: 'k' }, k),
        h('span', { className: 'v' + (cls ? ' ' + cls : '') }, v))
    }

    // ⚠️ 必须是变长参数：下面有 6 处调用是 Card(标题, Row(...), Row(...), ...) 形式。
    // 2026-10-08 踩过：写成 function Card(title, children) 时只收到**第一个** Row，
    // 其余行静默不渲染（「引擎与索引」只显示一行 Ollama 地址就是这个原因）。
    function Card(title) {
      var kids = Array.prototype.slice.call(arguments, 1)
      var head = title ? h('h4', null, title) : null
      return h.apply(null, ['div', { className: 'msem-card' }, head].concat(kids))
    }

    /* ── 页面 ─────────────────────────────────────────────────────── */
    function SemanticSettingsPage() {
      var sState = React.useState(null)
      var state = sState[0]
      var setState = sState[1]
      var sErr = React.useState(null)
      var err = sErr[0]
      var setErr = sErr[1]
      var sPeaks = React.useState(null)
      var peaks = sPeaks[0]
      var setPeaks = sPeaks[1]
      var sBusy = React.useState(false)
      var busy = sBusy[0]
      var setBusy = sBusy[1]
      var sSel = React.useState('standard')
      var sel = sSel[0]
      var setSel = sSel[1]
      var sCopied = React.useState('')
      var copied = sCopied[0]
      var setCopied = sCopied[1]
      var sSaving = React.useState(false)
      var saving = sSaving[0]
      var setSaving = sSaving[1]
      var sToast = React.useState('')
      var toast = sToast[0]
      var setToast = sToast[1]

      function load() {
        setErr(null)
        get('/memory-semantic/state').then(setState).catch(function (e) { setErr(String((e && e.message) || e)) })
      }
      React.useEffect(function () { load() }, [])

      function scanPeaks() {
        setBusy(true)
        get('/memory-semantic/peaks?limit=5')
          .then(setPeaks)
          .catch(function (e) { setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }

      /** 切 autoStart：异步按钮必须有状态反馈（点击即 disabled，收尾必恢复）。 */
      function toggleAutoStart() {
        if (saving) return
        var next = !(state && state.ollama && state.ollama.autoStart)
        setSaving(true)
        setErr(null)
        post('/memory-semantic/config', { ollama: { autoStart: next } })
          .then(function () {
            setToast(next ? '已开启自动拉起 ✓' : '已关闭自动拉起 ✓')
            setTimeout(function () { setToast('') }, 1800)
            return get('/memory-semantic/state').then(setState)
          })
          .catch(function (e) { setErr('切换失败：' + ((e && e.message) || e)) })
          .then(function () { setSaving(false) })
      }

      function copy(text, tag) {
        try {
          navigator.clipboard.writeText(text).then(function () {
            setCopied(tag)
            setTimeout(function () { setCopied('') }, 1600)
          })
        } catch (e) { setErr('复制失败：' + e) }
      }

      if (err && !state) {
        return h('div', { className: 'msem-page' },
          h('div', { className: 'msem-err' }, '读取失败：' + err),
          h('div', { className: 'msem-actions' }, h('button', { className: 'msem-btn', onClick: load }, '重试')))
      }
      if (!state) return h('div', { className: 'msem-page' }, h('div', { className: 'msem-muted' }, '加载中…'))

      var ol = state.ollama || {}
      var idx = state.index || {}
      var turns = state.turns || {}
      var g = state.graph
      var cmp = state.compaction || {}
      var presets = cmp.presets || []
      var mine = null
      var profiles = cmp.profiles || []
      for (var i = 0; i < profiles.length; i += 1) { if (profiles[i].profile === 'desktop') { mine = profiles[i]; break } }
      if (!mine && profiles.length) mine = profiles[0]
      var eff = (mine && mine.effective) || cmp.defaults || {}
      var chosen = null
      for (var j = 0; j < presets.length; j += 1) { if (presets[j].id === sel) { chosen = presets[j]; break } }
      var snippet = chosen
        ? ['          - id: compaction-basic', "            name: '@deepseek-ai/dsh-compaction-basic'", '            config:',
          '              thresholdRatio: ' + chosen.config.thresholdRatio, '              retainRatio: ' + chosen.config.retainRatio].join('\n')
        : ''

      return h('div', { className: 'msem-page' },
        /* 头部状态 */
        h('div', { className: 'msem-head' },
          h('span', { className: 'msem-badge ' + (ol.healthy ? 'msem-ok' : 'msem-warn') },
            h('span', { className: 'dot' }), ol.healthy ? '向量引擎可用' : '向量引擎降级（纯 BM25）'),
          h('span', { className: 'msem-badge msem-muted' }, ol.model || '—'),
          h('button', {
            className: 'msem-badge msem-toggle ' + (ol.autoStart ? 'msem-ok' : 'msem-muted'),
            disabled: saving,
            title: '点击切换：开启后，探测到 Ollama 没在跑时会在后台把它拉起来（不阻塞本轮对话）',
            onClick: toggleAutoStart,
          }, h('span', { className: 'dot' }), saving ? '切换中…' : ('autoStart ' + (ol.autoStart ? '开' : '关'))),
          toast ? h('span', { className: 'msem-hint' }, toast) : null),

        /* 引擎与索引 */
        Card('引擎与索引',
          Row('Ollama 地址', ol.url || '—'),
          Row('索引条数', fmtNum(idx.entries) + (idx.pendingEmbed ? '（待补 ' + idx.pendingEmbed + '）' : '')),
          Row('索引更新时间', fmtTime(idx.updated)),
          Row('轮次库', fmtNum(turns.total) + ' 轮 / ' + fmtNum(turns.sessions) + ' 会话'),
          Row('基线', (idx.db || '—').replace(/^.*[\\/]/, ''))),

        /* 图谱 */
        Card('记忆图谱',
          g
            ? h('div', null,
              Row('节点 / 边', fmtNum(g.nodeCount) + ' / ' + fmtNum(g.edgeCount)),
              Row('社区', fmtNum(g.communities) + '（阈值 ' + g.threshold + '）'),
              Row('建图时间', fmtTime(g.builtAt)))
            : h('div', { className: 'msem-muted' },
              state.workspace
                ? '尚未建图（可在对话里让 AI 调 memory_graph rebuild）'
                : '未识别到工作区（source=' + (state.workspaceSource || '?') + '）——索引/轮次/图谱都会显示为空')),

        /* 压缩档位 */
        Card('宿主压缩档位（compact-basic）',
          Row('当前生效', 'thresholdRatio ' + eff.thresholdRatio + ' ／ retainRatio ' + eff.retainRatio),
          Row('来源', mine ? (mine.untouched ? '吃官方默认（' + mine.profile + ' patch 里未配）' : '显式配置（' + mine.profile + '）') : '—'),
          h('div', { className: 'msem-presets', style: { marginTop: '10px' } },
            presets.map(function (p) {
              return h('button', {
                key: p.id,
                className: 'msem-preset' + (p.id === sel ? ' on' : ''),
                onClick: function () { setSel(p.id) },
              }, h('b', null, p.label), h('span', null, p.hint))
            })),
          h('pre', { className: 'msem-pre' }, snippet),
          h('div', { className: 'msem-actions' },
            h('button', { className: 'msem-btn', onClick: function () { copy(snippet, 'snippet') } },
              copied === 'snippet' ? '已复制 ✓' : '复制配置片段'),
            h('button', { className: 'msem-btn', disabled: busy, onClick: scanPeaks },
              busy ? '扫描中…' : '扫描会话峰值'),
            h('button', { className: 'msem-btn', onClick: load }, '刷新状态')),
          h('div', { className: 'msem-note' },
            '这一段只给片段、不代写：改宿主 profile 需要重启，且写坏会让宿主起不来。',
            ' 保守＝压得更晚、留更多原文；激进＝压得更早、省上下文。'),
          peaks
            ? h('div', { className: 'msem-peaks' },
              h('div', null, '扫描 ' + peaks.scanned + ' 个最大会话：普通请求峰值 ' + fmtNum(peaks.peakInputTokens) + ' tokens' +
                (peaks.peakCompactionInputTokens ? ' ／ 压缩时规模 ' + fmtNum(peaks.peakCompactionInputTokens) + ' tokens' : '')),
              h('div', { className: 'msem-muted' }, peaks.note || ''),
              (peaks.rows || []).slice(0, 5).map(function (r) {
                return h('div', { key: r.sessionId, className: 'msem-muted' },
                  r.sessionId.slice(0, 24) + ' · ' + r.zipMB + 'MB · 峰值 ' + fmtNum(r.peakInputTokens) +
                  (r.compactionEvents ? ' · 压缩 ' + r.compactionEvents + ' 次' : ''))
              }))
            : null),

        err ? h('div', { className: 'msem-err' }, err) : null,
        h('div', { className: 'msem-note' },
          '状态来自 /memory-semantic/state；开关写入插件自己的 ',
          h('code', null, '~/.dsh/dsh-memory-semantic.runtime.json'),
          '（立即生效、不碰宿主配置）。'))
    }

    /* ── 插件面 ───────────────────────────────────────────────────── */
    var name = 'dsh-memory-semantic'
    var inject = ['slots']

    function apply(ctx) {
      try {
        ensureCss()
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register({
            name: 'settings.section',
            id: 'memory-semantic',
            order: 36, // 紧挨「喵记忆」(order 35)
            label: '语义记忆',
          }, SemanticSettingsPage)
        })
        console.info('[dsh-memory-semantic] 已注册 settings.section「语义记忆」')
      } catch (e) {
        console.warn('[dsh-memory-semantic] 设置页注册失败：', e)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
