/**
 * turns.db —— 对话轮次记忆库（schema 与 migration）· dsh-memory-semantic 阶段一地基
 *
 * 移植自 graph-memory 1.6.0-beta.16 `src/store/db.ts` 的 m15/m16，按 DSH 的现实改造三处：
 *  1. **库独立**：`<workspace>/.dsh-semantic/turns.db`。绝不写 meow-memory 的 memory.db——
 *     那条红线是"不碰基座一字节"，轮次记忆是我们自己的机制层资产。
 *  2. **证据源是 DSH 不可变事件日志**：存 `session_id + 事件 seq`，不复制上游那张 gm_messages。
 *     日志是唯一真相源，seq 是稳定身份；重放同一轮不会产生第二条记忆。
 *  3. **同时留一份剥离注入块后的原文副本**（user_text / answer_text）：召回时不必去解压
 *     别的会话的多帧 zstd 日志（跨会话召回才不会慢），也让日志万一被清理时记忆仍可读。
 *     副本不替代来源：user_seq / answer_seq 随时可回日志核对。
 *
 * 手写 bundle，无构建步骤；依赖仅 Node 内置（node:sqlite / node:crypto / node:fs）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SEMANTIC_DIR = '.dsh-semantic'
const TURNS_FILE = 'turns.db'

/** 轮次结果状态（与上游枚举逐字一致，运行时校验用）。 */
export const OUTCOMES = ['completed', 'partial', 'failed', 'informational', 'unknown']

export function semanticDirOf(workspace) {
  return path.join(workspace, SEMANTIC_DIR)
}

export function turnsDbPathOf(workspace) {
  return path.join(semanticDirOf(workspace), TURNS_FILE)
}

/* ── migration 步骤：只追加，绝不改写已发布步骤 ─────────────────────── */

/** v1：轮次记忆主表 + 摘要向量。 */
function m1_turns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tm_turns (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      summary     TEXT NOT NULL,
      outcome     TEXT NOT NULL CHECK(outcome IN ('completed','partial','failed','informational','unknown')),
      user_seq    INTEGER NOT NULL,
      answer_seq  INTEGER NOT NULL,
      user_text   TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      answer_hash TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(session_id, user_seq)
    );
    CREATE INDEX IF NOT EXISTS ix_tm_turns_session
      ON tm_turns(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS ix_tm_turns_outcome
      ON tm_turns(outcome, updated_at DESC);

    CREATE TABLE IF NOT EXISTS tm_vectors (
      turn_id      TEXT PRIMARY KEY REFERENCES tm_turns(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `)
}

/**
 * v2：SPO 导航（摘要派生）。
 * 与"记忆条目相似图"分表分层——导航词项只服务轮次召回，不进 meow-memory 的图谱。
 */
function m2_navigation(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tm_terms (
      id           TEXT PRIMARY KEY,
      normalized   TEXT NOT NULL UNIQUE,
      display_text TEXT NOT NULL,
      community_id TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_tm_terms_community
      ON tm_terms(community_id);

    CREATE TABLE IF NOT EXISTS tm_triples (
      id           TEXT PRIMARY KEY,
      turn_id      TEXT NOT NULL REFERENCES tm_turns(id) ON DELETE CASCADE,
      session_id   TEXT NOT NULL,
      subject_id   TEXT NOT NULL REFERENCES tm_terms(id),
      predicate    TEXT NOT NULL,
      object_id    TEXT NOT NULL REFERENCES tm_terms(id),
      source_order INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      UNIQUE(turn_id, subject_id, predicate, object_id)
    );
    CREATE INDEX IF NOT EXISTS ix_tm_triples_turn
      ON tm_triples(turn_id, source_order, created_at);
    CREATE INDEX IF NOT EXISTS ix_tm_triples_subject
      ON tm_triples(subject_id);
    CREATE INDEX IF NOT EXISTS ix_tm_triples_object
      ON tm_triples(object_id);
  `)
}

/**
 * v3：抽取队列状态（对齐上游 graph-memory m11 的设计）。
 *
 * 上游把状态挂在 gm_messages 上（它的抽取单位是"消息"）；我们的单位是"轮次"，
 * 而"待抽取的轮次"**还没进 tm_turns**，所以另起一张表。字段与上游同构：
 * state(pending/succeeded/quarantined) ＋ attempts ＋ last_error ＋
 * next_retry_at(重试退避) ＋ updated_at，索引也按"状态 → 下次重试 → 会话 → 轮次"排。
 *
 * 为什么需要它：live-sink 的水位与串行链原先都在内存里，宿主重启即清空——
 * 2026-10-08 实测因此单会话丢过 20 轮（靠回填脚本才补回）。落库之后，
 * 重启可以扫表续抽，失败有明确上限与隔离，不再依赖"事后发现"。
 */
function m3_extraction_queue(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tm_extraction_queue (
      session_id    TEXT NOT NULL,
      turn_index    INTEGER NOT NULL,
      user_seq      INTEGER NOT NULL,
      answer_seq    INTEGER NOT NULL,
      workspace     TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'pending'
                    CHECK(state IN ('pending','succeeded','quarantined')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      next_retry_at INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (session_id, user_seq, answer_seq)
    );
    CREATE INDEX IF NOT EXISTS ix_tm_queue_due
      ON tm_extraction_queue(state, next_retry_at, session_id, turn_index);
  `)
}

/**
 * v4：会话级抽取水位（对齐上游 m12）。
 * 上游注释写得很准：「后台抽取不得读取仍在生成的当前轮」——
 * 它记的是"这个会话已经完成了第几轮"，抽取时据此划出安全边界。
 */
function m4_extraction_sessions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tm_extraction_sessions (
      session_id     TEXT PRIMARY KEY,
      completed_turn INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
  `)
}

/**
 * v5：队列补记路由（provider / model / effort）。
 *
 * 为什么必须存：恢复抽取发生在**宿主重启之后**，那时没有活着的 session 对象，
 * 而 `resolveRoute` 默认要问 `session.requestHeader()` 要 provider/model——
 * 拿不到就只能放弃这一轮。所以**在登记那一刻**（session 还活着）就把路由记下来。
 * 这与上游"把抽取所需信息一并落库、重启后据此续抽"是同一种思路。
 */
function m5_queue_route(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(tm_extraction_queue)').all().map((c) => c.name))
  if (!cols.has('provider')) db.exec('ALTER TABLE tm_extraction_queue ADD COLUMN provider TEXT')
  if (!cols.has('model')) db.exec('ALTER TABLE tm_extraction_queue ADD COLUMN model TEXT')
  if (!cols.has('effort')) db.exec('ALTER TABLE tm_extraction_queue ADD COLUMN effort TEXT')
}

const STEPS = [m1_turns, m2_navigation, m3_extraction_queue, m4_extraction_sessions, m5_queue_route]
export const SCHEMA_VERSION = STEPS.length

/** 增量迁移：按 _tm_migrations 记录的最大版本补跑，幂等。 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _tm_migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)')
  const cur = db.prepare('SELECT MAX(v) AS v FROM _tm_migrations').get()?.v ?? 0
  for (let i = cur; i < STEPS.length; i += 1) {
    STEPS[i](db)
    db.prepare('INSERT INTO _tm_migrations (v, at) VALUES (?, ?)').run(i + 1, Date.now())
  }
  return { from: cur, to: STEPS.length }
}

/**
 * 打开轮次库。
 * @param workspace 工作区根目录
 * @param options.readOnly 只读打开（不建目录、不迁移）
 * @param options.create 允许建目录与库文件
 */
export function openTurnsDb(workspace, options = {}) {
  if (!workspace || typeof workspace !== 'string') throw new TypeError('openTurnsDb: workspace 必填')
  const file = turnsDbPathOf(workspace)
  const readOnly = options.readOnly === true
  if (readOnly) return new DatabaseSync(file, { readOnly: true })
  if (options.create !== false) fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // 锁等待必须最先装：journal_mode 切换与建表迁移本身也会争锁
  // （上游 graph-memory beta.17 同款修复：busy handler before journal setup and migrations）
  db.exec('PRAGMA busy_timeout = 4000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

/** 库是否存在（不创建）。 */
export function turnsDbExists(workspace) {
  try { return fs.existsSync(turnsDbPathOf(workspace)) } catch { return false }
}
