// decisions.js 自测：record → list → get（用临时工作区，不碰真实数据）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDecision, listDecisions, getDecision } from '../lib/decisions.js'

const ws = mkdtempSync(join(tmpdir(), 'dec-test-'))
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.log('  ✗', msg) } }

try {
  const r1 = recordDecision(ws, {
    goal: '给 fact 层抽三元组',
    constraints: ['不改基座', '控制成本'],
    options: ['规则抽取', 'LLM 抽取', '混合'],
    chosen: '混合（规则候选 + LLM 只抽 fact 层）',
    reason: '成本与质量折中',
    evidence: ['试点 92/100 成功'],
    expected: '事实型查询能精确命中',
    actual: 'A 方案验证通过（分数 0.0328→0.0595）',
    conditions: ['fact 层 482 条'],
    status: 'succeeded',
    tags: ['记忆沙龙', '事实索引'],
  })
  ok(!!r1.id && r1.relation === 'observed_after', 'record 返回 id 且 relation=observed_after')
  ok(r1.constraints.length === 2, 'constraints 转成数组')
  ok(r1.status === 'succeeded', 'status 保留')

  const r2 = recordDecision(ws, { goal: '测试失败记录', chosen: '随便', status: 'failed' })
  ok(r2.status === 'failed', '失败记录也能存')

  const list = listDecisions(ws, { limit: 5 })
  ok(list.length === 2, 'list 返回 2 条')
  ok(list[0].createdAt >= list[1].createdAt, '按时间倒序')

  const got = getDecision(ws, r1.id)
  ok(got && got.chosen.includes('混合'), 'get 按 id 取到')

  const filtered = listDecisions(ws, { status: 'failed' })
  ok(filtered.length === 1 && filtered[0].status === 'failed', 'list 按 status 过滤')

  const tagged = listDecisions(ws, { tag: '事实索引' })
  ok(tagged.length === 1, 'list 按 tag 过滤')

  console.log(`\n${pass} passed, ${fail} failed`)
} finally {
  try { rmSync(ws, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.exit(fail === 0 ? 0 : 1)
