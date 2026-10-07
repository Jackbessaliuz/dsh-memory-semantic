/**
 * 注入消息的 source 形态。
 *
 * 背景（2026-10-05）：DSH 0.2 的 v4 会话格式**拒绝** `source.kind === 'plugin'`
 * （`dsh-session-format-v3-to-v4/lib/index.js` 抛 "format v4 message requires a
 * producer-owned source kind"），要求 producer-owned 形态 = `plugin:<包名>`。
 * 而 0.1.5（v3）反向依赖 `kind === 'plugin'`（client.js 的 UI 分支、index.js 的去重判断）。
 *
 * 【为什么不做版本判断（2026-10-05 定稿）】试过两条路都不成立：
 *   ① `import('@deepseek-ai/dsh-session-format-v3-to-v4')`——那个包是 0.2 独有，
 *      但**未必对插件可见**；
 *   ② `createRequire` 读 `@deepseek-ai/dsh-llm/package.json` 的版本——**读到的不是宿主的**！
 *      它走 Node 原生解析，从插件目录逐级上溯，先撞上 `_integrate\node_modules` 里的
 *      **本地旧副本**（实测在 0.2 桌面端里读到 0.1.5-rc.3）→ 判据被错误降级。
 * 而两种形态的坏法**不对称**：
 *   · v3 形态遇 0.2 → **整轮硬失败**（发不出任何消息）
 *   · v4 形态遇 0.1.5 → 只丢"插件注入"的 UI 标记 + 一处去重判断（轻微降级）
 * → **永远按 v4 走**，把默认压在不致命的那一侧。等 0.1.5 退役后这段注释就可以删了。
 */
/** 恒为 true：见文件头「为什么不做版本判断」。 */
export async function isV4Host() {
  return true
}

/**
 * 构造一条注入消息的 source（v4 producer-owned 形态）。
 * @param {string} plugin 包名（拼进 kind）
 * @param {string} summary 人读摘要
 */
export async function injectionSource(plugin, summary) {
  await isV4Host()
  return { kind: `plugin:${plugin}`, form: 'notice', summary }
}
