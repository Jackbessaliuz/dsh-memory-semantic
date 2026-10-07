/**
 * 端到端验证：真跑一遍 live-sink 管线，确认"含密钥的轮次"入库时已被脱敏
 * 跑法: node scripts/self-test-redact-e2e.mjs
 *
 * 与 self-test-redact 的分工：那个验函数，这个验**管线**——
 * 假 session + 假 llm 走完整的 projectTurn → 抽取 → upsertTurn 路径，
 * 最后直接查库，确认落盘的 user_text / answer_text / summary 都不含明文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSinkRuntime, normalizeLiveConfig } from '../lib/turns/live-sink.js';
import { openTurnsDb } from '../lib/turns/schema.js';
import { streamOf } from '../lib/turns/extract-runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(here, '..', '_tmp', 'self-test-redact-e2e');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });

// 假密钥（形态真、值假）
const GH = 'ghp_' + 'TESTONLY'.padEnd(36, '0');
const SK = 'sk-' + 'z9y8x7w6v5u4t3s2'.repeat(2);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` → ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
};

/* 夹具：假 session（含一条带密钥的真实用户消息 + 带密钥的回答） */
const seq = [];
const push = (event) => { seq[event.seq] = event; return event; };
push({ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: `帮我看看这个配置 token=${GH} 对不对` }], source: { kind: 'user' } } });
push({ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `这个 token 是 ${SK} ，我帮你换成环境变量` }] } } });
push({ seq: 2, type: 'turn/end', data: { turn: 0, reason: 'stop' } });

const session = {
  header: { id: 'session-e2e0000-0000-0000-0000-000000000000', cwd: WS },
  eventAt: (i) => seq[i],
  requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }),
};

// 假 llm：抽取结果里**也**塞一个密钥（验证 store 侧的兜底闸门）
const RAW = JSON.stringify({
  summary: `用户询问配置里的 ${GH} 是否可用，回答建议改用环境变量。`,
  outcome: 'completed',
  triples: [{ subject: '用户', predicate: '持有', object: `token ${SK}` }],
});
const fakeLlm = {
  stream() {
    return streamOf([
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'submit_result', argumentsDelta: RAW },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'submit_result', arguments: RAW } },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])();
  },
};

const runtime = createSinkRuntime({
  llm: fakeLlm,
  cfg: normalizeLiveConfig({ turns: { live: { enabled: true, vector: false } } }),
  logger: { info() {}, warn() {}, error() {} },
});

console.log('\n【端到端：走真实 handle() 管线】');
await runtime.handle(session, seq[2]);

const db = openTurnsDb(WS);
const row = db.prepare('SELECT * FROM tm_turns').get();
const triples = db.prepare('SELECT * FROM tm_triples').all();
const terms = db.prepare('SELECT display_text FROM tm_terms').all();
db.close();

const all = JSON.stringify({ row, triples, terms });
console.log('  落库轮次:', row ? `${row.summary.slice(0, 70)}…` : '(无)');

check('轮次确实入库了（管线跑通）', Boolean(row));
check('user_text 无密钥明文', row && !row.user_text.includes(GH), row?.user_text);
check('answer_text 无密钥明文', row && !row.answer_text.includes(SK), row?.answer_text);
check('summary 无密钥明文（模型抽取结果也被拦）', row && !row.summary.includes(GH));
check('三元组无密钥明文', !JSON.stringify(triples).includes(SK));
check('词项表无密钥明文', !JSON.stringify(terms).includes(SK));
check('脱敏标记已写入', all.includes('[已脱敏'), '未找到 [已脱敏 标记');
check('整库字节里都搜不到这两个假密钥', !all.includes(GH) && !all.includes(SK));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
console.log(`沙盒工作区（可删）: ${WS}`);
