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
  },
  graph: {
    topK: 8,
    /** 余弦阈值：2026-10-07 在 792 条真实记忆上扫出的拐点（0.64 起社区会碎） */
    edgeThreshold: 0.62,
    damping: 0.85,
    prIterations: 50,
    lpMaxIter: 50,
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

/**
 * 归一化整个插件配置。任何非法值都退回默认值，绝不抛错
 * （配置错误不该让插件加载失败——这是降级优先的设计）。
 */
export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const o = raw.ollama && typeof raw.ollama === 'object' ? raw.ollama : {}
  const r = raw.retrieval && typeof raw.retrieval === 'object' ? raw.retrieval : {}
  const g = raw.graph && typeof raw.graph === 'object' ? raw.graph : {}

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
    },
    graph: {
      topK: num(g.topK, DEFAULTS.graph.topK, 1, 100),
      edgeThreshold: num(g.edgeThreshold, DEFAULTS.graph.edgeThreshold, 0, 1),
      damping: num(g.damping, DEFAULTS.graph.damping, 0, 0.999),
      prIterations: num(g.prIterations, DEFAULTS.graph.prIterations, 1, 500),
      lpMaxIter: num(g.lpMaxIter, DEFAULTS.graph.lpMaxIter, 1, 500),
    },
  }
}

export default normalizeConfig
