# Self Evolve — 工具调用自进化插件

自动捕获 Agent 工具调用失败，同模式累计后触发 LLM 分析生成修复规则，写入置顶记忆（pinned memory）防止重复踩坑。已有规则再次失败时，对比式重分析精炼或补充规则。

**零 UI，零用户操作。** 安装启用后全自动运行，无需任何配置或交互。

## 核心机制

### 错误捕获

通过 `ctx.bus.subscribe()` 监听 session stream 的 `tool_execution_end` 事件，捕获 `isError: true` 的工具调用。
`tool_execution_start` 事件的 `args` 通过 `toolCallId` 桥接到对应的 end 事件，供 LLM 分析使用。

**覆盖范围**：不仅捕获主 Agent 的 tool 错误，也捕获 sub agent、workflow 中创建的子 session 的错误。
子 session 通过 `session-coordinator.executeIsolated()` 创建，其 `emitEvents: true` 参数将所有 session 事件转发到全局 EventBus。

### Agent 隔离

从 `sessionPath`（路径格式 `.../agents/{agentId}/sessions/{file}.jsonl`）提取 agentId，签名格式为 `{agentId}:{tool}_{pattern}`。
不同 agent 的同类错误使用独立的计数器、规则集和分析冷却，互不干扰。

### 错误签名（fixcache 风格）

纯关键词分类，零 LLM 调用。pattern 名通过 `endsWith("_" + pattern)` 从签名中匹配，避免 tool 和 pattern 中的下划线干扰。

| 分类 | 关键词 | 模式 |
|---|---|---|
| `file_not_found` | enoent, no such file, not found, 找不到, does not exist | DEFERRED（延迟 5 次） |
| `encoding` | encoding, gbk, utf, codec, chcp, cannot decode, ascii, latin | 普通（3 次） |
| `edit_failure` | no match found, oldtext, could not find the exact text, no changes made | 普通 |
| `validation` | validation, required parameter, missing required, must have, invalid type | 普通 |
| `parse_error` | json parse, not valid json, unexpected token, malformed, traceback, syntaxerror | 普通 |
| `ambiguous_match` | multiple matches, ambiguous, more than one occurrence | 普通 |
| `syntax_error` | syntax, 表达式错误, 语法, is not recognized, invalid syntax | EPHEMERAL |
| `git_conflict` | rejected, merge conflict, failed to push, not a git repository | EPHEMERAL |
| `timeout` | timeout, timed out, time limit, 超时 | EPHEMERAL |
| `network_error` | econnrefused, fetch failed, dns, socket, could not connect | EPHEMERAL |
| `rate_limit` | 429, rate limit, too many requests, quota, exceeded | EPHEMERAL |
| `sandbox_denied` | permission denied, eacces, sandbox, blocked by, operation not permitted | EPHEMERAL |
| `auth` | 403, 401, forbidden, unauthorized | EPHEMERAL |
| `cmd_not_found` | command not found, is not recognized, module not found | EPHEMERAL |
| `context_overflow` | context length, token limit, too long, maximum context | EPHEMERAL |
| `empty_result` | empty response, no output, no result | EPHEMERAL |
| `unclassified` | (兜底) | 开放分类（5 次） |

三种模式：
- **普通**：同一签名累计 3 次触发 LLM 分析
- **DEFERRED（延迟）**：累计 5 次触发，适用于 file_not_found 等高频低价值错误
- **EPHEMERAL（短暂）**：只计数不分析，适用于语法随手错、网络抖动等不可控因素

### 触发阈值

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| 普通 | 同一签名 ≥ 3 次 + 无规则 | 首次分析，生成规则 |
| DEFERRED | 同一签名 ≥ 5 次 | 首次分析 / 周期重分析 |
| EPHEMERAL | — | 只计数，不分析 |
| unclassified | 同一签名 ≥ 5 次 | 开放分类尝试 |
| 已有规则 + 新失败 | 同一签名每 ≥ 3 次 | 对比重分析 |

### 规则精炼（两次处置）

- **refine**：旧规则措辞还不够强 → 覆盖为更强版本（如「建议用正斜杠」→「必须用正斜杠」）
- **same**：规则正确但 Agent 忽略了 → 只累加次数，不改规则

### 用户删除规则的处理

如果用户在设置页的置顶记忆中手动删除了一条 `⚠` 开头的规则：

1. 下次同步周期检测到：规则 `written: true` 但内容不在置顶记忆中
2. 自动标记该规则为 `dismissed: true`
3. 规则保留在 `fix-rules.json`（数据不丢），但不再写回置顶记忆
4. 手动删除一次后永久生效

如需彻底清除某条规则，编辑 `fix-rules.json` 删除对应条目并 reload 插件。

### 置顶记忆同步

通过 REST API（`GET/PUT /api/pinned?agentId=xxx`）同步。
端口和 token 从 `server-info.json` 读取，不依赖环境变量。

- **启动时**：插件加载后 5 秒同步一次（`startPinnedSync`）
- **规则变更后**：立即同步，绕过 30 秒冷却（`syncPinnedMemory(ctx, true)`）
- **冷却**：`startPinnedSync` 的显式调用有 30 秒冷却，防止频繁冗余同步

## 如何识别插件生成的置顶记忆

在置顶记忆（pinned memory）中，Self Evolve 生成的条目标记为：

```
⚠ pattern → 修复建议（根因）
```

例如：
```
⚠ file_not_found → 读文件前先stat确认路径是否存在 不存在则创建（路径指向的文件不存在）
```

**特征**：以 `⚠ pattern → fix（cause）` 格式，pattern 不包含 agentId（agent 由 `?agentId=` API 参数隔离）。
手动添加的置顶记忆不会使用此格式。

## 结构

```
self-evolve/
├── manifest.json              # 插件清单（含 network.fetch + allowLocalhost 声明）
├── index.js                   # 核心：错误捕获、分类器、LLM 分析、规则管理、pinned 同步
├── CONTEXT.md                 # 共享术语表与架构决策记录
└── README.md
```

## 调试

日志通过 `plugin_dev_diagnostics` 查看，所有日志以 `[self-evolve]` 前缀标识：

| Level | 内容 |
|-------|------|
| `debug` | 原始捕获、噪声过滤、记录计数、同步跳过 |
| `info`  | 分析触发、规则生成/精炼、用户驳回、同步结果 |
| `warn`  | 同步失败 |

dataDir 路径（取决于安装方式）：
- dev 版本：`%USERPROFILE%\.hanako\plugin-data\dev\self-evolve\`
- 正式版本：`%USERPROFILE%\.hanako\plugin-data\self-evolve\`


## 完整工作流（从错误到置顶记忆）

### 阶段一：捕获

```
工具调用失败 (isError=true)
  → ctx.bus.subscribe 收到 tool_execution_end 事件
  → 噪声过滤（跳过普通工具、空错误、无 agentId 的情况）
  → 提取 error 文本 + args（通过 toolCallId 桥接 start 事件）
  → 送入 processFailure
```

**注意**：不是所有工具错误都设置 `isError=true`（如 edit 的 "text not found" 类错误平台层不标记），这些错误插件无法捕获。

### 阶段二：分类

```
processFailure 接收错误
  → classifyError 做关键词匹配（17 组，零 LLM 开销）
  → 生成 baseSig，格式 tool_parttern
  → 拼接完整签名：{agentId}:{tool}_{pattern}
  → 存入 recordFailure → signatureCounts 累积
```

### 阶段三：分析决策

```
判断是否触发 LLM 分析：

  DEFERRED（如 file_not_found）→ count % 5 === 0 才触发
  EPHEMERAL（如 syntax_error）→ 跳过，只计数
  普通模式 → strike（count % 3 === 0）触发
  unclassified → count % 5 === 0 触发开放分类

  ↓ 非延迟 + strike 通过后

  分析冷却检查 → 同一签名 5 分钟内不重复分析
  → 调用 LLM（analyzeNewPattern 或 analyzeWhyRuleFailed）
  → 生成修复规则（refine / same / 新规则）
```

### 阶段四：规则存储

```
LLM 返回后
  → upsertFixRule(parsed, timestamp, signature)
  → fixRules Map 更新（key = 完整 signature）
  → saveRules() 持久化到 fix-rules.json

  ↓ 同步触发

  syncPinnedMemory(ctx, true)  // force=true 绕过 30 秒冷却
  → 获取当前置顶列表（GET /api/pinned）
  → 筛选活跃规则（排除 dismissed）
  → 过滤掉所有已有 ⚠ 条目
  → PUT 写入所有活跃规则
```

### 时序图（简化）

```
时间线         主 Agent                     self-evolve                   置顶记忆
  │             │                              │                             │
  ├─ 工具失败 ──→  tool_execution_end ────────→  │                             │
  │             │                              │ 分类 + 计数                  │
  │             │                              │ strike 到达?                 │
  │             │                              │ 分析冷却?                    │
  ├─ ... N 次 ──→                              │                              │
  │             │                              → LLM 分析（首次/重分析）       │
  │             │                              → upsertFixRule               │
  │             │                              → syncPinnedMemory(force) ───→ PUT
  │             │                              │                              │
  ├─ 下次推理 ──→  置顶记忆已注入上下文 ───────→  │                              │
  ↓             ↓                              ↓                              ↓
```

---

## 维护指南

### 一、修改分类器（ERROR_CLASSIFIERS）

- 新增 pattern 时确保 pattern 名不与已有的 tool 名产生歧义（如 `media_generate-image` 和 `validation` 都安全）
- pattern 可含下划线（如 `file_not_found`），pattern 提取用 `endsWith("_" + pattern)` 匹配，不受影响
- 关键词不要太宽泛如 `redirect`、`stdout`、`missing`——会导致误分类，挤占正常错误的触发额度
- 新增 DEFERRED 模式时，在 `DEFERRED_PATTERNS` Set 中加入 pattern 名
- 新增 EPHEMERAL 模式时，在 `ERROR_CLASSIFIERS` 条目中加 `ephemeral: true`

### 二、修改 LLM 分析 Prompt

- **示例即教学**：LLM 会模仿示例中的思维模式，示例的根因判断错误会污染所有分析结果（ENOENT 教训）
- **措辞强度影响结果**：要求使用「必须」「禁止」的 prompt 比仅要求「祈使句」产出更好的规则
- **不要诱导 LLM 产生不存在的行为**：如 JSON 输出格式中包含 `supplement` / `pattern` 字段，LLM 可能会填充它们
- 修改后务必触发真实错误测试——人工判断逻辑是否正确往往不够，LLM 的行为不可预测

### 三、签名与规则 key 的陷阱

- `fixRules` 的 key 是完整签名 `{agentId}:{tool}_{pattern}`，不是 pattern 名
- 补充/精炼时 upsert 的 key 必须与首次创建时的签名一致，否则生成孤儿规则
- `signatureCounts` 同理——不同 key 的计数独立
- 所有规则 key 不一致会导致：规则存在于 `fix-rules.json` 但对比式重分析永远找不到它

### 四、同步机制

- `syncPinnedMemory` 的 `force=true` 绕过 30 秒冷却——仅在规则变更后使用
- `startPinnedSync` 定期调度受冷却限制，用于确保启动时一次同步
- filter 会移除所有 `⚠` 开头的行——这意味着所有活跃规则每次被完整重写，不存在"增量"同步
- 检测用户删除逻辑：`written=true` 但 pattern 不在 pinned 中 → 标记 dismissed

### 五、持久化文件

- `failures.jsonl`：每行一个 JSON 记录，上限 500 条（`MAX_RECORDS = 500`），超出时丢弃最旧的
- `fix-rules.json`：JSON 数组，插件管理，不设上限（实际不会超过几十条）
- 两个文件都在 `ctx.dataDir` 下，dev 版和 community 版路径不同
- 插件运行中直接清文件会被内存数据覆盖——必须先 reload 让内存重置，再清文件

### 六、测试方法

**快速触发各模式：**

| 目标模式 | 触发方式 |
|---------|---------|
| file_not_found | 读不存在的文件 |
| edit_failure / validation | edit 只传 newText 不传 oldText（触发 validation 错误） |
| syntax_error (EPHEMERAL) | 执行不存在的命令 |
| encoding | 用错误的编码参数 |
| timeout | 等待分析冷却（5 分钟） |

**验证工具：**
- `plugin_dev_diagnostics("self-evolve")` — 查看运行日志
- `GET /api/pinned?agentId=xxx` — 查看置顶记忆
- 直接读 `failures.jsonl` 和 `fix-rules.json` — 查看持久化数据

### 七、常见陷阱

1. **edit "not found" 错误不设置 `isError=true`** — 平台层行为，插件无法捕获。只有缺参数的 validation 类 edit 错误能被捕获
2. **分析冷却（5 分钟）在全插件共享**——同一 signature 的分析被冷却拦截后，直到冷却过期都不会触发重分析。测试时临时设为 0，测完务必恢复
3. **sub agent 的规则会写入主 agent 的 pinned**——`syncPinnedMemory` 获取所有 agent 的非 dismissed 规则，一律通过 `?agentId=hanako` 写入。sub agent 的规则 H 在 pinned 中能看到，但重分析回路不认（签名不同）
4. **分析失败不影响主流程**——LLM 调用失败（utility 模型不可用、网络错误）只记一条 warn 日志，插件继续计数，不影响 Agent 正常执行
