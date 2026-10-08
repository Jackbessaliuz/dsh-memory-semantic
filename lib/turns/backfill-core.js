/**
 * backfill-core —— 「会话日志 → 完成轮的投影」这一步，在线与离线共用（2026-10-08）
 *
 * 为什么单独抽出来（而不是把整条回填流程抽出来）：
 *   **抽取器两边本质不同，不该硬凑** ——
 *     · live-sink（在线）：走宿主的 `ctx.llm.stream()`，路由沿用会话自身的 provider/model；
 *     · backfill-turns.mjs（离线）：直连 DeepSeek API，自己读 key。
 *   但**"从日志里读出哪些轮是完整的、每轮的 user/answer 是什么"这一步必须完全一致**，
 *   否则在线写入与离线回填会打架。live-sink 开头的注释里当初就写了这条原则：
 *   「与回填路径共用 project.js 的 hasVisibleAnswer / isRealUserTurn / projectTurn
 *     —— **同一套语义**，在线写入与离线回填不会打架」。
 *   这里就是把那一步固定下来，两边都调它。
 *
 * 恢复场景为什么需要它：宿主重启后**没有活着的 session 对象**（`session.eventAt()` 走不通），
 * 所以"把上一次没抽完的轮次捡回来"只能回到日志这个唯一真相源——正是本模块干的事。
 */
import { findSessionLog, readSessionEvents } from './session-log.js'
import { projectCompletedTurns } from './project.js'

/**
 * 读出某个会话的全部"完成轮"。
 *
 * @param {string} sessionId 形如 `session-xxxx…`
 * @returns {{ file: string, sessionId: string, turns: Array }|null} 找不到日志返回 null
 */
export function loadCompletedTurns(sessionId) {
  const file = findSessionLog(sessionId)
  if (!file) return null
  const log = readSessionEvents(file)
  const sid = String(log.header?.id ?? sessionId)
  const turns = projectCompletedTurns(log.events, { sessionId: sid })
  return { file, sessionId: sid, header: log.header, turns }
}

/**
 * 按 `userSeq` 从完成轮里挑出指定几轮（队列里记的就是 userSeq/answerSeq）。
 * 返回的每项带 `turnIndex`，可直接写库。
 *
 * @param {Array} turns loadCompletedTurns 的 turns
 * @param {Array<{userSeq:number}>} wanted 待补清单
 */
export function pickTurns(turns, wanted) {
  const want = new Set((wanted || []).map((w) => Number(w.userSeq)))
  return (turns || []).filter((t) => want.has(Number(t.userSeq)))
}
