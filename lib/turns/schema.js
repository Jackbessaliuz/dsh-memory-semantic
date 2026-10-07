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

const STEPS = [m1_turns, m2_navigation]
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
