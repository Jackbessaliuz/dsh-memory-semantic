/**
 * turns store —— 轮次记忆的存储原语
 *
 * 移植自 graph-memory `src/store/store.ts`（turnMemoryId / upsertTurnMemory /
 * upsertNavigationTerm / replaceNavigationTriples / saveTurnVector 一组），
 * 但把"源消息"从上游自建的 gm_messages 换成 DSH 的事件 seq。
 *
 * 三条不可动摇的规则（来自移植指南）：
 *  - 稳定身份：id 全部由内容派生（sha256），重放同一轮不产生重复记忆；
 *  - 原子替换：某轮的三元组在一个事务里整体替换，失败整体回滚；
 *  - 不做语义门禁：只做空白归一化，不重写模型的 subject/predicate/object。
 */
import { createHash } from 'node:crypto'
import { OUTCOMES } from './schema.js'
import { redactSecrets } from './redact.js'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 词项归一化：只做空白折叠 + 小写，不碰语义。 */
export function normalizeTerm(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 稳定 id：一轮由 (sessionId, 排序后的 source seq) 唯一决定。 */
export function turnIdOf(sessionId, seqs) {
  const key = [...seqs].map((n) => Number(n)).sort((a, b) => a - b).join('\0')
  return `tm-${sha256(`${sessionId}\0${key}`).slice(0, 32)}`
}

export function termIdOf(normalized) {
  return `nt-${sha256(normalized).slice(0, 32)}`
}

export function tripleIdOf(turnId, subjectId, predicate, objectId) {
  return `tr-${sha256(`${turnId}\0${subjectId}\0${predicate}\0${objectId}`).slice(0, 32)}`
}

/** 摘要内容哈希（向量是否需要重算的依据）。 */
export function contentHashOf(text) {
  return sha256(String(text ?? ''))
}

function assertNonEmpty(value, label) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(`${label} 不能为空`)
  return text
}

function assertSeq(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} 必须是非负整数，收到 ${value}`)
  return value
}

/**
 * 写入（或幂等更新）一条轮次记忆。
 * @param db openTurnsDb 返回的连接
 * @param input { sessionId, turnIndex, summary, outcome, userSeq, answerSeq, userText, answerText }
 */
export function upsertTurn(db, input) {
  const sessionId = assertNonEmpty(input?.sessionId, 'sessionId')
  // 落盘闸门（2026-10-06）：所有文本字段在写库前统一脱敏。
  // 收口在这里而不是各调用点——回填脚本、live sink、将来的任何新入口都自动受保护。
  const summary = assertNonEmpty(redactSecrets(input?.summary), 'summary')
  const outcome = redactSecrets(String(input?.outcome ?? ''))
  if (!OUTCOMES.includes(outcome)) throw new TypeError(`outcome 必须是 ${OUTCOMES.join('/')}，收到 ${outcome || '(空)'}`)
  const userSeq = assertSeq(input?.userSeq, 'userSeq')
  const answerSeq = assertSeq(input?.answerSeq, 'answerSeq')
  if (userSeq === answerSeq) throw new TypeError('userSeq 与 answerSeq 不能相同：一轮必须有问有答')
  const userText = assertNonEmpty(redactSecrets(input?.userText), 'userText')
  const answerText = assertNonEmpty(redactSecrets(input?.answerText), 'answerText')
  const turnIndex = assertSeq(Number(input?.turnIndex ?? 0), 'turnIndex')

  const id = turnIdOf(sessionId, [userSeq, answerSeq])
  const now = Date.now()
  db.prepare(`
    INSERT INTO tm_turns
      (id, session_id, turn_index, summary, outcome, user_seq, answer_seq, user_text, answer_text, answer_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      turn_index=excluded.turn_index,
      summary=excluded.summary,
      outcome=excluded.outcome,
      user_text=excluded.user_text,
      answer_text=excluded.answer_text,
      answer_hash=excluded.answer_hash,
      updated_at=excluded.updated_at
  `).run(id, sessionId, turnIndex, summary, outcome, userSeq, answerSeq, userText, answerText, contentHashOf(answerText), now, now)
  return getTurn(db, id)
}

export function getTurn(db, id) {
  const row = db.prepare('SELECT * FROM tm_turns WHERE id=?').get(id)
  return row ? toTurn(row) : null
}

export function getTurnsByIds(db, ids) {
  const statement = db.prepare('SELECT * FROM tm_turns WHERE id=?')
  const out = []
  for (const id of ids) {
    const row = statement.get(id)
    if (row) out.push(toTurn(row))
  }
  return out
}

/** 某会话最近的轮次（旧→新返回，便于当"前几轮摘要"喂抽取模型）。 */
export function getRecentTurnsBySession(db, sessionId, limit = 5) {
  const n = Math.max(1, Math.min(50, Number(limit) || 5))
  return db.prepare(`
    SELECT * FROM tm_turns WHERE session_id=? ORDER BY turn_index DESC, updated_at DESC LIMIT ?
  `).all(sessionId, n).map(toTurn).reverse()
}

/** 该会话里 turn_index 小于 beforeTurn 的最近轮次（抽取时防自喂）。 */
export function getRecentTurnsBefore(db, sessionId, beforeTurn, limit = 5) {
  const n = Math.max(1, Math.min(50, Number(limit) || 5))
  if (!Number.isInteger(beforeTurn)) return []
  return db.prepare(`
    SELECT * FROM tm_turns WHERE session_id=? AND turn_index < ?
    ORDER BY turn_index DESC, updated_at DESC LIMIT ?
  `).all(sessionId, beforeTurn, n).map(toTurn).reverse()
}

/** 全局最近轮次（跨会话召回的时间基准）。 */
export function getRecentTurns(db, limit = 10) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10))
  return db.prepare('SELECT * FROM tm_turns ORDER BY updated_at DESC LIMIT ?').all(n).map(toTurn)
}

function upsertTerm(db, text) {
  const display = String(text ?? '').trim().replace(/\s+/g, ' ')
  const normalized = normalizeTerm(display)
  if (!normalized) throw new TypeError('导航词项不能为空')
  const id = termIdOf(normalized)
  const now = Date.now()
  db.prepare(`
    INSERT INTO tm_terms (id, normalized, display_text, community_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(normalized) DO UPDATE SET
      display_text=excluded.display_text,
      updated_at=excluded.updated_at
  `).run(id, normalized, display, now, now)
  return id
}

/**
 * 原子替换某一轮的全部导航三元组。
 * 任何一步失败（含空 predicate）→ 整体回滚，旧三元组不被破坏。
 */
export function replaceTriples(db, turnId, sessionId, triples = []) {
  assertNonEmpty(turnId, 'turnId')
  assertNonEmpty(sessionId, 'sessionId')
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM tm_triples WHERE turn_id=?').run(turnId)
    const insert = db.prepare(`
      INSERT OR IGNORE INTO tm_triples
        (id, turn_id, session_id, subject_id, predicate, object_id, source_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let order = 0
    for (const triple of triples) {
      // 同上：三元组也是模型从对话里抽的，可能把密钥当词项带进来
      const predicate = redactSecrets(String(triple?.predicate ?? '')).trim().replace(/\s+/g, ' ')
      if (!predicate) throw new TypeError('predicate 不能为空（不猜、不补、不造边）')
      const subjectId = upsertTerm(db, redactSecrets(triple?.subject))
      const objectId = upsertTerm(db, redactSecrets(triple?.object))
      // source_order 是入场序号：同一毫秒写入也能稳定复现输出顺序（上游按 created_at,id 排，同毫秒会飘）。
      insert.run(tripleIdOf(turnId, subjectId, predicate, objectId), turnId, sessionId, subjectId, predicate, objectId, order, Date.now())
      order += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return getTriplesForTurn(db, turnId)
}

export function getTriplesForTurn(db, turnId) {
  return db.prepare(`
    SELECT t.id, t.turn_id AS turnId, t.session_id AS sessionId, t.predicate,
           s.display_text AS subject, s.id AS subjectId,
           o.display_text AS object, o.id AS objectId,
           s.community_id AS subjectCommunityId, o.community_id AS objectCommunityId
    FROM tm_triples t
    JOIN tm_terms s ON s.id=t.subject_id
    JOIN tm_terms o ON o.id=t.object_id
    WHERE t.turn_id=? ORDER BY t.source_order, t.created_at, t.id
  `).all(turnId).map((r) => ({ ...r }))
}

export function getTriplesForTurns(db, turnIds = []) {
  const out = []
  for (const id of turnIds) out.push(...getTriplesForTurn(db, id))
  return out
}

/** 词项 id → 命中该词项的轮次（图路线的种子）。 */
export function turnIdsForTerms(db, termIds = []) {
  const out = new Set()
  const statement = db.prepare('SELECT DISTINCT turn_id AS id FROM tm_triples WHERE subject_id=? OR object_id=?')
  for (const termId of termIds) for (const row of statement.all(termId, termId)) out.add(String(row.id))
  return [...out]
}

/** 文本里出现的词项（严格词法回退用：查询词直接命中导航词项）。 */
export function findTermIdsByText(db, text) {
  const normalized = normalizeTerm(text)
  if (!normalized) return []
  return db.prepare('SELECT id FROM tm_terms WHERE ? LIKE \'%\' || normalized || \'%\' ORDER BY length(normalized) DESC LIMIT 20')
    .all(normalized).map((r) => String(r.id))
}

/* ── 向量 ──────────────────────────────────────────────────────────── */

function toBlob(vec) {
  const f32 = Float32Array.from(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

export function blobToVector(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  return Float32Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)))
}

export function saveTurnVector(db, turnId, content, vec) {
  assertNonEmpty(turnId, 'turnId')
  if (!Array.isArray(vec) && !(vec instanceof Float32Array)) throw new TypeError('向量必须是数字数组')
  if (!vec.length) throw new TypeError('向量不能为空')
  db.prepare(`
    INSERT INTO tm_vectors (turn_id, content_hash, embedding, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(turn_id) DO UPDATE SET
      content_hash=excluded.content_hash, embedding=excluded.embedding, updated_at=excluded.updated_at
  `).run(turnId, contentHashOf(content), toBlob(vec), Date.now())
}

export function getTurnVectorHash(db, turnId) {
  return db.prepare('SELECT content_hash AS h FROM tm_vectors WHERE turn_id=?').get(turnId)?.h ?? null
}

export function getTurnVector(db, turnId) {
  const row = db.prepare('SELECT embedding FROM tm_vectors WHERE turn_id=?').get(turnId)
  return row ? blobToVector(row.embedding) : null
}

export function allTurnVectors(db) {
  return db.prepare('SELECT turn_id AS turnId, embedding FROM tm_vectors').all()
    .map((r) => ({ turnId: String(r.turnId), vector: blobToVector(r.embedding) }))
}

/* ── 抽取队列与会话水位（对齐上游 m11/m12；2026-10-08） ─────────────── */

/**
 * 登记一条待抽取。幂等：同一轮重复触发只更新 workspace/updated_at，
 * **不重置已有的 state**（否则失败重试会被重置成 pending，形成死循环）。
 */
export function enqueueExtraction(db, rec) {
  const now = Date.now()
  // provider/model/effort 只在**传了值**时才覆盖（第二次登记用来补路由，
  // 别用 null 把第一次记下的值抹掉）。
  db.prepare(`
    INSERT INTO tm_extraction_queue
      (session_id, turn_index, user_seq, answer_seq, workspace, provider, model, effort,
       state, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    ON CONFLICT(session_id, user_seq, answer_seq) DO UPDATE SET
      workspace=excluded.workspace,
      provider=COALESCE(excluded.provider, tm_extraction_queue.provider),
      model=COALESCE(excluded.model, tm_extraction_queue.model),
      effort=COALESCE(excluded.effort, tm_extraction_queue.effort),
      updated_at=excluded.updated_at
  `).run(
    rec.sessionId, rec.turnIndex, rec.userSeq, rec.answerSeq, rec.workspace,
    rec.provider ?? null, rec.model ?? null, rec.effort ?? null, now, now,
  )
}

/**
 * 标记抽取结果。
 * - succeeded：清掉错误与重试时间；
 * - failed：attempts+1，写 last_error，并给 next_retry_at 指数退避；
 *   超过 maxAttempts 转 quarantined（隔离，等人工/回填，不再自动重试）。
 * 退避基数与上限可调，默认 1 分钟起、最长 1 小时。
 */
export function markExtraction(db, key, result = {}) {
  const now = Date.now()
  const ok = result.state === "succeeded"
  if (ok) {
    db.prepare(`
      UPDATE tm_extraction_queue
        SET state='succeeded', last_error=NULL, next_retry_at=NULL, updated_at=?
      WHERE session_id=? AND user_seq=? AND answer_seq=?
    `).run(now, key.sessionId, key.userSeq, key.answerSeq)
    return { state: "succeeded" }
  }
  const maxAttempts = Number.isFinite(result.maxAttempts) ? result.maxAttempts : 3
  const baseMs = Number.isFinite(result.baseMs) ? result.baseMs : 60_000
  const capMs = Number.isFinite(result.capMs) ? result.capMs : 3_600_000
  const row = db.prepare(`
    SELECT attempts FROM tm_extraction_queue
    WHERE session_id=? AND user_seq=? AND answer_seq=?
  `).get(key.sessionId, key.userSeq, key.answerSeq)
  const attempts = Number(row?.attempts ?? 0) + 1
  const quarantined = attempts >= maxAttempts
  const backoff = Math.min(capMs, baseMs * Math.pow(2, attempts - 1))
  db.prepare(`
    UPDATE tm_extraction_queue
      SET state=?, attempts=?, last_error=?, next_retry_at=?, updated_at=?
    WHERE session_id=? AND user_seq=? AND answer_seq=?
  `).run(
    quarantined ? "quarantined" : "pending",
    attempts,
    result.error ? String(result.error).slice(0, 500) : null,
    quarantined ? null : now + backoff,
    now,
    key.sessionId, key.userSeq, key.answerSeq,
  )
  return { state: quarantined ? "quarantined" : "pending", attempts, backoff }
}

/** 取到点的待抽取项（pending 且 next_retry_at 已到，或从未设过）。 */
export function listDueExtractions(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50
  return db.prepare(`
    SELECT session_id AS sessionId, turn_index AS turnIndex,
           user_seq AS userSeq, answer_seq AS answerSeq, workspace,
           provider, model, effort,
           state, attempts, last_error AS lastError
    FROM tm_extraction_queue
    WHERE state='pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY session_id, turn_index
    LIMIT ?
  `).all(now, limit).map((r) => ({ ...r }))
}

/** 队列统计（诊断/自述用，对齐上游会把 pending/succeeded/quarantined 打出来）。 */
export function extractionQueueStats(db) {
  const rows = db.prepare(`
    SELECT state, COUNT(*) AS n FROM tm_extraction_queue GROUP BY state
  `).all()
  const out = { pending: 0, succeeded: 0, quarantined: 0, total: 0 }
  for (const r of rows) { out[String(r.state)] = Number(r.n); out.total += Number(r.n) }
  return out
}

/** 会话水位：这个会话已完成到第几轮（用于划出"不读正在生成的轮"的安全边界）。 */
export function getSessionWatermark(db, sessionId) {
  const row = db.prepare(`
    SELECT completed_turn AS t FROM tm_extraction_sessions WHERE session_id=?
  `).get(sessionId)
  return row ? Number(row.t) : -1
}

export function setSessionWatermark(db, sessionId, completedTurn) {
  db.prepare(`
    INSERT INTO tm_extraction_sessions (session_id, completed_turn, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      completed_turn=MAX(completed_turn, excluded.completed_turn),
      updated_at=excluded.updated_at
  `).run(sessionId, completedTurn, Date.now())
}

/* ── 统计与自检 ────────────────────────────────────────────────────── */

export function statsOf(db) {
  const one = (sql) => db.prepare(sql).get()?.n ?? 0
  return {
    turns: one('SELECT COUNT(*) AS n FROM tm_turns'),
    sessions: one('SELECT COUNT(DISTINCT session_id) AS n FROM tm_turns'),
    terms: one('SELECT COUNT(*) AS n FROM tm_terms'),
    triples: one('SELECT COUNT(*) AS n FROM tm_triples'),
    vectors: one('SELECT COUNT(*) AS n FROM tm_vectors'),
    outcomes: db.prepare('SELECT outcome, COUNT(*) AS n FROM tm_turns GROUP BY outcome').all().map((r) => ({ ...r })),
  }
}

export function hasTurns(db) {
  return (db.prepare('SELECT COUNT(*) AS n FROM tm_turns').get()?.n ?? 0) > 0
}

function toTurn(row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnIndex: Number(row.turn_index),
    summary: String(row.summary),
    outcome: String(row.outcome),
    userSeq: Number(row.user_seq),
    answerSeq: Number(row.answer_seq),
    userText: String(row.user_text),
    answerText: String(row.answer_text),
    answerHash: String(row.answer_hash),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}
