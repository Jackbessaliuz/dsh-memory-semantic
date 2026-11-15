/**
 * recall-ledger —— 召回账本（2026-11-15 第一批）
 *
 * 为什么需要：现在只知道"最后返回了什么"，不知道某条记忆是在哪一步丢的。
 * 实测「473 个记忆插件」时，向量排第 2、BM25 没上榜、融合后被时间权重压住，
 * 但光看工具输出根本看不出来——只能靠猜。账本把每一步都留下来。
 *
 * 记什么（GPT 评审要求的"完整漏斗"）：
 *   query/k/mode/project → 向量前 10 → BM25 前 10 → 融合+时间加权后前 10 → 最终返回
 *
 * 硬约束：
 *   ① 不阻塞主流程：record() 只入内存队列，异步 flush；
 *   ② 有界：队列上限 200 条、文件上限 5MB（超了轮转成 .1，只留一份）；
 *   ③ 不写基座：独立 ndjson，放 <workspace>/.dsh-semantic/。
 */

import { appendFile, statSync, renameSync } from 'node:fs'

export function createRecallLedger(options = {}) {
  const filePath = options.filePath
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 5 * 1024 * 1024
  const queueMax = Number.isFinite(options.queueMax) ? options.queueMax : 200
  const enabled = options.enabled !== false

  /** @type {any[]} */
  const queue = []
  let flushing = false
  let disposed = false
  let size = 0
  let sized = false
  let wrote = 0
  let errors = 0

  function measureOnce() {
    if (sized) return
    sized = true
    try { size = statSync(filePath).size } catch { size = 0 }
  }

  function schedule() {
    if (flushing || disposed || queue.length === 0) return
    flushing = true
    setImmediate(flushNow)
  }

  function flushNow() {
    if (disposed) { flushing = false; return }
    if (queue.length === 0) { flushing = false; return }
    const batch = queue.splice(0, queue.length).map((e) => {
      try { return JSON.stringify(e) } catch { return JSON.stringify({ t: Date.now(), err: 'serialize-failed' }) }
    }).join('\n') + '\n'
    measureOnce()
    if (size + Buffer.byteLength(batch) > maxBytes) {
      // 轮转：只保留上一份 .1，不堆历史（账本是诊断用，不是档案）
      try { renameSync(filePath, filePath + '.1') } catch { /* 首次写没有旧文件 */ }
      size = 0
    }
    appendFile(filePath, batch, 'utf8', (err) => {
      if (err) { errors++; if (errors <= 3) console.error('[recall-ledger] append failed:', err.message) }
      else { wrote++; size += Buffer.byteLength(batch) }
      if (queue.length > 0) setImmediate(flushNow)
      else flushing = false
    })
  }

  return {
    record(event) {
      if (!enabled || disposed) return
      if (queue.length >= queueMax) queue.shift() // 满了丢最旧的：诊断事件不值得拖垮聊天
      queue.push(event)
      schedule()
    },
    /** 等待队列写完（测试/退出前用；正常调用不需要） */
    flushNow,
    stats() { return { enabled, queued: queue.length, bytes: size, wrote, errors } },
    dispose() { disposed = true },
  }
}

export default createRecallLedger
