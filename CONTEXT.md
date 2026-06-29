# self-evolve 共享术语表与架构决策

## 术语表

| 术语 | 定义 |
|---|---|
| **错误签名 (signature)** | 由关键词分类器生成的字符串，如 `hanako:bash_syntax_error`，格式为 `{agentId}:{tool}_{pattern}`，用于聚拢同类失败 |
| **Strike** | 同一签名每累积 N 次触发一次分析事件（普通模式 N=3，DEFERRED/unclassified 模式 N=5） |
| **DEFERRED 模式** | 适用于 `file_not_found` 等高频低价值错误，每 5 次触发一次 LLM 分析，独立于 strike 机制 |
| **EPHEMERAL 模式** | 短暂性错误（语法随手错、Git 冲突、网络抖动等），只计数不分析 |
| **精炼 (refine)** | 对比式重分析的一种处置：旧规则措辞太弱，升级为更强版本 |
| **补充 (supplement)** | 已废弃，原用于对比式重分析中生成补充规则（v0.1.0 后合并到 refine） |
| **不变 (same)** | 对比式重分析的一种处置：规则正确，Agent 忽略，只累加计数 |
| **unclassified** | 关键词分类器未命中的失败签名后缀，每 5 次尝试开放分类 |
| **dismissed** | 用户手动删除置顶记忆中的规则后自动标记，标记后不再写回 |

## 架构决策记录

### ADR-1：错误签名用关键词分类而非哈希

**日期**：2026-06-30

**决策**：使用 fixcache 风格的关键词表（17 组）生成错误签名，而不是对 error message 做哈希。

**理由**：
- 哈希导致同类错误因参数差异被分散到不同签名，攒不够触发次数无法分析
- 关键词分类将 `ENOENT: C:\a.txt` 和 `ENOENT: C:\b.txt` 归入同一个 `file_not_found`
- 纯字符串匹配，零 LLM 开销

**替代方案**：哈希 + 前 80 字（已被否决，理由同上）

### ADR-2：分层触发阈值

**日期**：2026-06-30（最后更新：2026-06-30）

**决策**：三种触发模式——普通模式 N 次触发（strikeThreshold，通过"灵敏/适中/标准"枚举配置，对应 1/2/3 次，默认"适中"即 2 次）、DEFERRED 模式 `strikeThreshold×2`（下限 3）次触发、unclassified 模式同样 `strikeThreshold×2`（下限 3）次触发。

**理由**：
- 95% 的失败是一次性笔误（漏引号、错参数名），分析这些浪费 token
- `file_not_found` 在文件操作中频繁出现，DEFERRED 避免过早消耗分析预算
- 5 次是"偶发"和"持续模式"的经验分界线

**历史**：DEFERRED 和 unclassified 最初为 10 次，调整为 5 次（减少等待时间，提升反馈速度）。

### ADR-3：对比式重分析而非简单淘汰

**日期**：2026-06-30

**决策**：已有规则再次失败时，把旧规则和新失败一起送给 LLM 分析"为什么没生效"，而非简单淘汰旧规则。

**理由**：
- 淘汰（eviction）可能丢掉仍有价值的规则
- 精炼（措辞升级）比丢弃更有效
- 处置 same 防止不必要的规则修改

**后续变更**：v0.1.0 初期支持 `refine` / `supplement` / `same` 三种处置，其中 supplement 创建独立新规则。但因签名不匹配导致孤儿规则问题，`supplement` 已被移除并合并到 `refine`（覆盖旧规则）。

### ADR-4：Bus subscribe 替代 Pi SDK 扩展

**日期**：2026-06-30

**决策**：使用 `ctx.bus.subscribe()` 监听 session stream 的 `tool_execution_end` 事件捕获错误，替代原 `extensions/self-evolve.js`（Pi SDK `api.on("tool_result", ...)`）。

**理由**：
- Pi SDK 扩展的 `tool_result` 事件仅对 Pi coding agent 会话生效，Hanako agent 会话不触发
- `tool_execution_end` 是 session-coordinator 向 EventBus 无条件转发的 session 事件，对所有会话类型生效
- 删除了 `extensions/` 目录和 `globalThis._selfEvolveHook` 全局引用

**代价**：`tool_execution_end` 事件不携带 `args` 参数，需通过 `toolCallId` 桥接 `tool_execution_start` 事件缓存。

**覆盖范围**：不仅主 Agent 会话，sub agent 和 workflow 子会话的错误同样被捕获。子会话通过 `session-coordinator.executeIsolated()` 创建（`subagent-tool.ts:440`、`workflow-tool.ts:233` 均设置 `emitEvents: true`），其 `session.subscribe()` 回调将所有事件（含 `tool_execution_end`）通过 `this._d.emitEvent()` 转发到全局 EventBus。self-evolve 的无 sessionPath 过滤的全局订阅能收到所有子会话事件。

### ADR-5：Agent 隔离

**日期**：2026-06-30

**决策**：错误签名格式为 `{agentId}:{tool}_{pattern}`，从 `sessionPath` 路径（`.../agents/{agentId}/sessions/{file}.jsonl`）提取 agentId。

**理由**：
- 不同 agent 的同类错误应独立计数和分析，避免跨 agent 干扰触发阈值
- 生成的修复规则仅适用于对应 agent，agentId 前缀防止规则写入错误 agent 的置顶记忆

**影响**：`fixRules` Map 的 key 包含 agentId，pinned memory 显示时通过 `formatSingleRule` 去掉 agentId 前缀（`⚠ file_not_found → ...` 而非 `⚠ hanako:file_not_found → ...`），因为 agent 已由 `?agentId=` API 参数隔离。

### ADR-6：Pinned memory 格式

**日期**：2026-06-30（最后更新：2026-06-30）

**决策**：使用 `⚠ pattern → fix（cause）` 单行格式（不带 Markdown `- ` 前缀），通过 `formatPinnedRules` 生成。

**理由**：
- `pinned-memory-store.ts` 的 `renderPinnedMarkdown` 在写入 pinned.md 时自动为每条内容加 `- ` 前缀
- 旧版本已加了 `- ` 前缀，导致 pinned.md 中显示 `- - ⚠ ...` 格式
- 去掉前缀后，renderPinnedMarkdown 自动补全 `- `，保证格式正确

**已知问题**：从 JSON store 中读取的历史条目可能残留 `- ⚠` 旧格式，过滤正则 `/^(?:- )?⚠\s+.+\s+→\s+.+/` 同时兼容两种格式。

### ADR-7：手动删除即驳回

**日期**：2026-06-30

**决策**：用户手动删除置顶记忆中的 `⚠` 规则后，插件自动标记 `dismissed: true` 并不再写回。

**理由**：
- 用户删除 = 不想要这条规则，应尊重用户意图
- 规则数据保留在 `fix-rules.json` 中（数据不丢），但不再同步到置顶记忆
- 如需恢复，手动编辑 `fix-rules.json` 将 `dismissed` 设为 `false` 并 reload

**影响**：`FixRule` 数据结构新增 `written: boolean` 和 `dismissed: boolean` 字段。`syncPinnedMemory` 每次从 API 获取当前置顶列表，比对规则内容，检测已写入但缺失的规则。

### ADR-8：零 UI

**日期**：2026-06-30

**决策**：不提供任何 WebView/iframe 界面，仅通过 pinned memory + 日志暴露状态。

**理由**：
- 降低用户心智负担
- 插件价值在"静默防错"，不在仪表盘
- 置顶记忆本身已是可见状态
- `plugin_dev_diagnostics` 提供运行日志查看

### ADR-9：PLAID（纯 LLM 分析）

**日期**：2026-06-30（最后更新：2026-06-30）

**决策**：LLM 分析使用 `ctx.bus.request('model:sample-text', ...)` 调 Hana 配置的 utility 模型。

**理由**：
- 非流式调用，不阻塞 Agent 工具执行
- 走 Hana 内置的 utility 模型链路，无需插件自己管理 API key
- 分析失败不影响 Agent 主流程

**已验证**：`server/index.ts:628` 注册了 `model:sample-text` handler，调用 `callText()` 非流式 LLM。

### ADR-10：端口从 server-info.json 读取

**日期**：2026-06-30

**决策**：`syncPinnedMemory` 的 HTTP 请求端口从 `server-info.json` 的 `port` 字段读取，而非依赖 `process.env.HANA_PORT` 或硬编码默认值。

**理由**：
- 实际端口（如 14500）可能与默认值（12222）不同
- `server-info.json` 是 Hana 的标准配置来源，token 和 port 在同一文件中
- 避免因端口不匹配导致的"fetch failed"

### ADR-11：Pattern 名用 endsWith 匹配替代 lastIndexOf 分割

**日期**：2026-06-30

**决策**：从签名 `{agentId}:{tool}_{pattern}` 提取 pattern 名时，使用已知 pattern 列表做 `endsWith` 匹配，替代 `lastIndexOf("_") + 1` 分割。

**理由**：
- tool 名（如 `media_generate-image`）和 pattern 名（如 `file_not_found`、`syntax_error`）都可能包含下划线
- `lastIndexOf("_")` 对 `read_file_not_found` 返回 `found`，而非 `file_not_found`
- DEFERRED/EPHEMERAL 中含下划线的 pattern 全部匹配不到对应 Set：`file_not_found` 从未走 DEFERRED（一直是 3 次触发），EPHEMERAL 中 8 个含下划线 pattern 漏过滤

**替代方案**：`ERROR_CLASSIFIERS.map(c => c.pattern).find(p => baseSig.endsWith("_" + p)) || "unclassified"`。

**影响**：DEFERRED 和 EPHEMERAL 分类在修复后才真正生效。此前一段时间的运行中所有分类实际都按普通模式处理。

### ADR-12：首次分析优先根因判断 用强制性措辞

**日期**：2026-06-30

**决策**：`analyzeNewPattern` prompt 删除了将 ENOENT 误判为路径格式问题的示例，改为要求 LLM 先分析真实根因再生成规则。fix 必须使用「必须」「禁止」等强制性措辞。

**理由**：
- 原示例教 LLM 把「文件不存在」归因为「反斜杠路径格式」，导致测试中所有 `file_not_found` 规则都指向了错误的根因
- 建议性措辞（如「建议用正斜杠」）在 Agent 推理时遵守率低，强制性措辞（「必须用正斜杠」）效果更好

### ADR-13：规则变更后同步绕过冷却

**日期**：2026-06-30

**决策**：`syncPinnedMemory` 增加 `force` 参数，`processFailure` 中的调用传 `true` 绕过 30 秒冷却。

**理由**：
- 补充或精炼规则后应立即写入 pinned，等 30 秒冷却可能导致 sync 被拦截后无重试机制
- 冷却仅适用于 `startPinnedSync` 这类非关键的冗余同步

### ADR-14：移除 supplement 合并到 refine

**日期**：2026-06-30

**决策**：supplement 分支改用原始 `signature` 作为 upsert key，行为与 refine 一致。

**理由**：
- supplement 用独立 key（`{agentId}:{parsed.pattern}`）存储，与原始签名不匹配，成为孤儿规则
- 下次同类错误触发时 `fixRules.get(signature)` 找不到该规则，对比式重分析失效
- 移除后不影响功能：LLM 分析的 refine 覆盖足以应对