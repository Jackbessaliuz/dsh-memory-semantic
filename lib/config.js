/**
 * config.js —— dsh-memory-semantic 的统一配置（默认值 ＋ 覆盖 ＋ 校验）
 *
 * 为什么单独一个文件：2026-10-07 之前所有可调参数都是散在代码里的常量
 * （RRF_K / OUTPUT_CHARS / 图谱阈值 / Ollama 地址……），使用者只能改源码。
 * 开源前把旋钮集中到这里：profile patch 的 `config:` 段即可覆盖，
 * 不用碰任何 .js。
 *
 * 优先级：显式 config ＞ 环境变量 ＞ 内置默认值。
 * 兼容：原有环境变量 MEMORY_SEMANTIC_OLLAMA / MEMORY_SEMANTIC_MODEL 仍生效。
 */

export const DEFAULTS = {
  ollama: {
    url: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    /** true＝探测不到就后台拉起；false＝只探测（探测到已在跑就用向量，不去启动） */
    autoStart: false,
    /** 可选：显式指定 ollama 可执行文件路径（绿色版/自定义安装用） */
    executablePath: '',
    /** 单次健康探测超时（本机回环正常 <10ms） */
    probeTimeoutMs: 800,
    /** 拉起后愿意等待的毫秒数；0＝不等，本次直接走 BM25（点火不等人） */
    warmupWaitMs: 0,
    /** 嵌入批大小 */
    embedBatch: 32,
  },
  retrieval: {
    /** RRF 融合常数与候选池 */
    rrfK: 60,
    rrfPool: 10,
    /** 单条记忆返回的最大字符数 */
    outputChars: 220,
    /** bge-m3 官方推荐的中文检索指令（去掉会明显掉分） */
    queryInstruction: '为这个句子生成表示以用于检索相关文章：',
    /**
     * 时间加权（2026-11-15 第零批②）：同一主题下新记忆优先于旧快照。
     * 背景：回放集实测「473 个记忆插件」被 10 月的旧数据 4424 压过——不是找不对，
     * 是新旧两条都相关时旧的那条排前面。因子 = floor + (1-floor)*exp(-age/halfLife)。
     * 只作用于 fact/project/lesson/topic；user/soul/rules 是长期偏好与红线，不随时间过期。
     * 设 recencyHalfLife=0 即完全关闭。
     */
    recencyHalfLife: 30,
    recencyFloor: 0.6,
    recencyLevels: ['fact', 'project', 'lesson', 'topic'],
    /**
     * 单路第 1 保底加成（2026-11-15）：纯 RRF 下「两路都进前10但都靠后」会碾压
     * 「某一路排第1」的条目。向量语义在实测里明显强于 BM25（top1 4/7 vs 1/7），
     * 所以向量第 1 给 0.02、BM25 第 1 给 0.01。设 0 关闭。
     */
    firstPlaceBonus: 0,
    firstPlaceBonusBm25: 0,
    /**
     * 路线权重（2026-11-15 第二批）：RRF 融合时向量路与 BM25 路的相对权重。
     * 依据：回放集实测向量明显强于 BM25；且单路上榜的条目原本拿不到双路条目的分数。
     * 设 vectorWeight=2 / bm25Weight=1 后，"向量第2、BM25没上榜"的条目能靠 2/62 挤进前列。
     */
    // 合计加成上限（2026-11-16 GPT 建议）：min(facts+PPR, α×基础分)。
    // α=0.10 是保护上限、不是最优值；新增候选（基础分为 0）不受此限。
    bonusAlpha: 0.10,
    vectorWeight: 1,
    bm25Weight: 1,
  },
  graph: {
    topK: 8,
    /** 余弦阈值：2026-10-07 在 792 条真实记忆上扫出的拐点（0.64 起社区会碎） */
    edgeThreshold: 0.62,
    damping: 0.85,
    prIterations: 50,
    lpMaxIter: 50,
  },
  /**
   * 防复读退化折叠（thinking-guard 并入，2026-10-18）。
   * 默认值全部沿用独立插件那份（它拿 235 个真实会话校准过）；dryRun 默认 false，
   * 调判据时先开 dryRun 观察一天再真折叠。
   */
  guard: {
    enabled: true,
    minChars: 400,
    minRepeats: 25,
    maxUnit: 30,
    minShare: 0.20,
    tailChars: 4000,
    foldToolSteps: true,
    digestChars: 200,
    digestArgs: 160,
    maxDigests: 4,
    textChars: 200,
    includeSubagents: true,
    dryRun: false,
    // 2026-11-15 GPT 评审后默认关闭：v2 判据分不清"否定变化"，且阈值只在英文块上校准过
    rotationGuard: false,
    shortShareMin: 0.35,
    topUnitShareMin: 0.50,
  },
}

function num(value, fallback, min, max) {
  // 注意：Number(null)===0、Number('')===0、Number([])===0 —— 不能直接 Number()，
  // 否则配置里写 null/空串会被静默当成 0 再钳到最小值（2026-10-07 自测抓到的真 bug）。
  if (typeof value !== 'number' && typeof value !== 'string') return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}
function str(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
/** 层级列表：接受数组或逗号串；非法值退回默认（"不衰减"也是一种合法配置，用 [] 表示） */
function levelsOf(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean)
  return DEFAULTS.retrieval.recencyLevels.slice()
}

/**
 * 归一化整个插件配置。任何非法值都退回默认值，绝不抛错
 * （配置错误不该让插件加载失败——这是降级优先的设计）。
 */
export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const o = raw.ollama && typeof raw.ollama === 'object' ? raw.ollama : {}
  const r = raw.retrieval && typeof raw.retrieval === 'object' ? raw.retrieval : {}
  const g = raw.graph && typeof raw.graph === 'object' ? raw.graph : {}
  const gd = raw.guard && typeof raw.guard === 'object' ? raw.guard : {}

  return {
    ...raw,
    ollama: {
      url: str(process.env.MEMORY_SEMANTIC_OLLAMA, null) || str(o.url, DEFAULTS.ollama.url),
      model: str(process.env.MEMORY_SEMANTIC_MODEL, null) || str(o.model, DEFAULTS.ollama.model),
      autoStart: bool(o.autoStart, DEFAULTS.ollama.autoStart),
      executablePath: str(o.executablePath, DEFAULTS.ollama.executablePath),
      probeTimeoutMs: num(o.probeTimeoutMs, DEFAULTS.ollama.probeTimeoutMs, 100, 30000),
      warmupWaitMs: num(o.warmupWaitMs, DEFAULTS.ollama.warmupWaitMs, 0, 60000),
      embedBatch: num(o.embedBatch, DEFAULTS.ollama.embedBatch, 1, 256),
    },
    retrieval: {
      rrfK: num(r.rrfK, DEFAULTS.retrieval.rrfK, 1, 1000),
      rrfPool: num(r.rrfPool, DEFAULTS.retrieval.rrfPool, 1, 100),
      outputChars: num(r.outputChars, DEFAULTS.retrieval.outputChars, 40, 4000),
      queryInstruction: typeof r.queryInstruction === 'string' ? r.queryInstruction : DEFAULTS.retrieval.queryInstruction,
      recencyHalfLife: num(r.recencyHalfLife, DEFAULTS.retrieval.recencyHalfLife, 0, 3650),
      recencyFloor: num(r.recencyFloor, DEFAULTS.retrieval.recencyFloor, 0, 1),
      recencyLevels: levelsOf(r.recencyLevels),
      firstPlaceBonus: num(r.firstPlaceBonus, DEFAULTS.retrieval.firstPlaceBonus, 0, 0.1),
      firstPlaceBonusBm25: num(r.firstPlaceBonusBm25, DEFAULTS.retrieval.firstPlaceBonusBm25, 0, 0.1),
      vectorWeight: num(r.vectorWeight, DEFAULTS.retrieval.vectorWeight, 0.1, 10),
      bm25Weight: num(r.bm25Weight, DEFAULTS.retrieval.bm25Weight, 0.1, 10),
    },
    graph: {
      topK: num(g.topK, DEFAULTS.graph.topK, 1, 100),
      edgeThreshold: num(g.edgeThreshold, DEFAULTS.graph.edgeThreshold, 0, 1),
      damping: num(g.damping, DEFAULTS.graph.damping, 0, 0.999),
      prIterations: num(g.prIterations, DEFAULTS.graph.prIterations, 1, 500),
      lpMaxIter: num(g.lpMaxIter, DEFAULTS.graph.lpMaxIter, 1, 500),
    },
    // thinking-guard 并入（2026-10-18）：任何非法值退回默认，绝不抛错
    guard: {
      enabled: bool(gd.enabled, DEFAULTS.guard.enabled),
      minChars: num(gd.minChars, DEFAULTS.guard.minChars, 0, 100000),
      minRepeats: num(gd.minRepeats, DEFAULTS.guard.minRepeats, 1, 10000),
      maxUnit: num(gd.maxUnit, DEFAULTS.guard.maxUnit, 1, 500),
      minShare: num(gd.minShare, DEFAULTS.guard.minShare, 0, 1),
      tailChars: num(gd.tailChars, DEFAULTS.guard.tailChars, 100, 200000),
      foldToolSteps: bool(gd.foldToolSteps, DEFAULTS.guard.foldToolSteps),
      digestChars: num(gd.digestChars, DEFAULTS.guard.digestChars, 0, 5000),
      digestArgs: num(gd.digestArgs, DEFAULTS.guard.digestArgs, 0, 5000),
      maxDigests: num(gd.maxDigests, DEFAULTS.guard.maxDigests, 0, 20),
      textChars: num(gd.textChars, DEFAULTS.guard.textChars, 0, 5000),
      includeSubagents: bool(gd.includeSubagents, DEFAULTS.guard.includeSubagents),
      dryRun: bool(gd.dryRun, DEFAULTS.guard.dryRun),
      rotationGuard: bool(gd.rotationGuard, DEFAULTS.guard.rotationGuard),
      shortShareMin: num(gd.shortShareMin, DEFAULTS.guard.shortShareMin, 0, 1),
      topUnitShareMin: num(gd.topUnitShareMin, DEFAULTS.guard.topUnitShareMin, 0, 1),
    },
  }
}

export default normalizeConfig
