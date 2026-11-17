/**
 * build-facts —— 事实索引「一键构建」的 CLI 外壳（2026-11-19）
 *
 * 真正的实现在 `lib/facts-build.js`（因为发布包只含 lib，设置页的一键构建
 * 必须能在发布包里跑；脚本不能是唯一入口）。
 *
 * 用法：
 *   node scripts/build-facts.mjs --dry              # 只统计：多少条要抽、约多少 token
 *   node scripts/build-facts.mjs --limit=20         # 小样本先验质量
 *   node scripts/build-facts.mjs --concurrency=6    # 正式跑
 *   node scripts/build-facts.mjs --force            # 忽略增量，全部重抽
 */
import path from 'node:path'
import { planFactsBuild, buildFactsIndex } from '../lib/facts-build.js'

const args = process.argv.slice(2)
const numArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const flag = (name) => args.includes(`--${name}`)

// 缺省从脚本位置往上三级（插件目录 → _integrate → 工作区），不写死本机路径
const workspace = process.env.DSH_WORKSPACE || path.resolve(import.meta.dirname, '../../..')
const dry = flag('dry')
const force = flag('force')
const limit = numArg('limit', 0)
const concurrency = Math.max(1, Math.min(8, numArg('concurrency', 4)))

const plan = planFactsBuild(workspace, { force })
console.log(
  `记忆 ${plan.memories} 条｜已有三元组 ${plan.indexedTriples} 条｜`
  + `待抽 ${plan.todo} 条（未变 ${plan.unchanged} 条）`,
)

if (dry) {
  console.log(
    `--dry：待抽 ${plan.todo} 条，输入约 ${Math.round(plan.inputChars / 1000)}k 字`
    + `（≈${Math.round(plan.inputChars / 2)} tokens），不花钱直接退出`,
  )
  process.exit(0)
}
if (plan.todo === 0 && !force) {
  console.log('没有需要重抽的记忆，索引已是最新。')
  process.exit(0)
}

const started = Date.now()
const result = await buildFactsIndex({
  workspace,
  force,
  limit,
  concurrency,
  onProgress: (p) => {
    if (p.done % 20 === 0 || p.done === p.total) {
      console.log(`  进度 ${p.done}/${p.total}｜成功 ${p.ok} 失败 ${p.failed}｜${Math.round(p.elapsedMs / 1000)}s`)
    }
  },
})

const cost = (result.tokenIn / 1e6) * 1.0 + (result.tokenOut / 1e6) * 4.0
console.log(
  `完成｜重抽 ${result.replaced} 条记忆｜新索引 ${result.triples} 条三元组（原 ${result.countBefore}）`
  + `｜token 入 ${result.tokenIn} / 出 ${result.tokenOut}`
  + `｜耗时 ${Math.round((Date.now() - started) / 1000)}s｜约 ¥${cost.toFixed(2)}`,
)
if (result.failed > 0) console.log(`⚠️ ${result.failed} 条抽取失败（旧数据已保留，可重跑补）`)
