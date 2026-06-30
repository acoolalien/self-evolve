/**
 * Self Evolve — 核心入口
 *
 * 工作流：
 *   1. afterToolCall 钩子捕获失败
 *   2. 关键词分类 → 错误签名（fixcache 风格）
 *   3. 同类错误累计 ≥ strikeThreshold 次 → 触发 LLM 分析
 *   4. 首次分析 → 生成 FixRule
 *   5. 已有规则又失败 ≥ strikeThreshold 次 → 对比式重分析（精炼/补充规则）
 *   6. 规则写入 fileRuleDir + 同步到 pinned memory（- 列表项格式）
 *
 * 权限依赖：
 *   - model.sample → bus.request('model:sample-text') 调 utility 模型
 *   - session      → 监控当前会话
 *   - resource.read → 读 server-info.json 获取 token
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";

// ── 常量 ──
const MAX_RECORDS = 500;
let strikeThreshold = 3;                  // 同一签名累计多少次触发 LLM 分析（可通过配置修改）
const ANALYZE_COOLDOWN_MS = 5 * 60 * 1000; // 同一签名两次分析的间隔
const PINNED_SYNC_COOLDOWN_MS = 30_000;
const RULES_FILE = "fix-rules.json";
const FAILURES_FILE = "failures.jsonl";

// ── 运行时状态 ──
let persistPath = null;
let _llmUnavailableLogged = false;
let rulesPath = null;
let failuresPath = null;
let lastPinnedSync = 0;
let _initialSyncDone = false;
let recordIdSeq = 0;

const failureLog = new Map();          // id → FailureRecord
const fixRules = new Map();            // pattern → FixRule
const signatureCounts = new Map();     // signature → occurrenceCount
const analyzedSignatures = new Map();  // signature → lastAnalyzedAt

// ── 从 tool_execution_start 缓存 args 供 tool_execution_end 使用 ──
const argsCache = new Map();           // toolCallId → args

// ── 类型 ──
/**
 * @typedef {Object} FailureRecord
 * @property {string} id
 * @property {string} tool
 * @property {string} args
 * @property {string} error
 * @property {string} signature  - 关键词分类签名
 * @property {number} timestamp
 * @property {string} sessionPath
 */

/**
 * @typedef {Object} FixRule
 * @property {string} pattern
 * @property {string} label
 * @property {string} fix         - 单行修复指令
 * @property {string} cause       - 根因
 * @property {number} firstSeen
 * @property {number} lastSeen
 * @property {number} occurrenceCount
 * @property {number} refineCount - 被精炼次数
 */

// ── 关键词分类器（fixcache 风格） ──

/** 失败分类关键词表。匹配顺序从上到下，命中即停止。 */
const ERROR_CLASSIFIERS = [
  { pattern: "encoding",      keywords: ["encoding", "gbk", "utf", "codec", "chcp", "cannot decode", "ascii", "latin", "out-file", "tee-object"] },
  { pattern: "edit_failure",  keywords: ["no match found", "could not find the exact text", "find the exact text", "no changes made", "the replacement produced", "oldtext", "old_text", "string to replace"] },
  { pattern: "validation",    keywords: ["validation", "required parameter", "missing required", "must have", "invalid type", "expected string"] },
  { pattern: "parse_error",   keywords: ["json parse", "not valid json", "unexpected token", "malformed", "traceback", "modulenotfounderror", "importerror", "syntaxerror"] },
  { pattern: "ambiguous_match",keywords: ["multiple matches", "ambiguous", "more than one occurrence", "found \\d+ occurrences"] },
  // ── 以下为不可控模式（只计数，不分析）──
  { pattern: "file_not_found", keywords: ["enoent", "no such file", "not found", "找不到", "does not exist", "cannot find", "is not a directory", "eisdir", "offset", "beyond end of file", "is not a file", "/c/users", "/c/program"] },
  { pattern: "syntax_error",  keywords: ["syntax", "表达式或语句", "语法", "不是内部", "不是外部", "is not recognized", "unexpected end", "invalid syntax"], ephemeral: true },
  { pattern: "git_conflict",  keywords: ["rejected", "cannot pull with rebase", "unstaged changes", "merge conflict", "please commit", "would be overwritten", "not a git repository", "failed to push"], ephemeral: true },
  { pattern: "timeout",       keywords: ["timeout", "timed out", "time limit", "超时"], ephemeral: true },
  { pattern: "network_error", keywords: ["econnrefused", "connection refused", "enotfound", "dns", "network", "socket", "fetch failed", "econnreset", "eai_again", "could not connect", "exit code 7", "exit code 28", "exit code 6", "curl:"], ephemeral: true },
  { pattern: "rate_limit",    keywords: ["429", "rate limit", "too many requests", "quota", "exceeded", "throttled"], ephemeral: true },
  { pattern: "sandbox_denied", keywords: ["permission denied", "access denied", "not allowed", "eacces", "sandbox", "blocked by", "operation not permitted", "refusing to run", "win32-exec", "openservice 失败", "> nul", "cmd null-device"], ephemeral: true },
  { pattern: "auth",          keywords: ["403", "401", "forbidden", "unauthorized", "unauthorised"], ephemeral: true },
  { pattern: "cmd_not_found", keywords: ["command not found", "is not recognized as an internal", "cannot find module", "module not found"], ephemeral: true },
  { pattern: "context_overflow", keywords: ["context length", "token limit", "too long", "maximum context", "prompt too long"], ephemeral: true },
  { pattern: "empty_result",  keywords: ["empty response", "no output", "returned nothing", "no result"], ephemeral: true },
  { pattern: "unclassified",   keywords: [] }, // 兜底
];

// ── 短暂性模式标记表（只计数，不分析） ──
const EPHEMERAL_PATTERNS = new Set(
  ERROR_CLASSIFIERS.filter(c => c.ephemeral).map(c => c.pattern)
);

// ── 延迟分析模式（周期性 LLM 判断，不直接触发）──
const DEFERRED_PATTERNS = new Set(["file_not_found"]);
function classifyError(tool, errorMsg) {
  // 剥离 "Received arguments:" 段
  let clean = (errorMsg || "");
  const argIdx = clean.indexOf("\nReceived arguments:");
  if (argIdx >= 0) clean = clean.substring(0, argIdx);

  const msg = clean.toLowerCase();
  const toolKey = String(tool || "unknown").toLowerCase().replace(/\s+/g, "_");

  // 全量扫描取最长匹配关键词，消除短词截胡长词的排序依赖
  // 长度相同时数组顺序靠前的优先
  let bestPattern = null;
  let bestKwLen = -1;

  for (const cls of ERROR_CLASSIFIERS) {
    if (cls.keywords.length === 0) continue; // unclassified 兜底
    for (const kw of cls.keywords) {
      if (msg.includes(kw) && kw.length > bestKwLen) {
        bestPattern = cls.pattern;
        bestKwLen = kw.length;
      }
    }
  }

  if (bestPattern === null) return `${toolKey}_unclassified`;
  return `${toolKey}_${bestPattern}`;
}

// ── 工具函数 ──

function nextId() {
  return `se_${Date.now()}_${++recordIdSeq}`;
}

function now() { return Date.now(); }

// ── 持久化 ──

function loadPersisted() {
  try {
    if (failuresPath && existsSync(failuresPath)) {
      const lines = readFileSync(failuresPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r.id && r.signature) {
            failureLog.set(r.id, r);
            signatureCounts.set(r.signature, (signatureCounts.get(r.signature) || 0) + 1);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  try {
    if (rulesPath && existsSync(rulesPath)) {
      const raw = JSON.parse(readFileSync(rulesPath, "utf-8"));
      if (Array.isArray(raw)) {
        for (const rule of raw) {
          if (rule.pattern) fixRules.set(rule.pattern, rule);
        }
      }
    }
  } catch { /* skip */ }
}

function saveFailures() {
  if (!failuresPath) return;
  try {
    const entries = [...failureLog.values()].slice(-MAX_RECORDS);
    writeFileSync(failuresPath, entries.map(r => JSON.stringify(r)).join("\n"), "utf-8");
  } catch { /* skip */ }
}

function saveRules() {
  if (!rulesPath) return;
  try {
    writeFileSync(rulesPath, JSON.stringify([...fixRules.values()], null, 2), "utf-8");
  } catch { /* skip */ }
}

// ── 错误记录 + 累积计数 ──

/**
 * 噪声过滤：丢弃无实际错误信息的失败
 * - 纯退出码（Exit code N + no output）
 * - Git 警告（LF will be replaced by CRLF）
 * - 空错误文本
 */
function isNoiseError(errorText) {
  if (!errorText || !errorText.trim()) return true;

  // 从 JSON 错误结构中提取纯文本内容
  let text = errorText.trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.content?.[0]?.type === "text" && typeof parsed.content[0].text === "string") {
      text = parsed.content[0].text;
    }
  } catch { /* 非 JSON 格式，直接用原文本 */ }

  const t = text.toLowerCase();
  // 纯退出码 + 无输出
  if (/^\(no output\)\s*$/i.test(t)) return true;
  if (/^command exited with code\s+\d+/i.test(t)) return true;
  if (/^\(no output\)\s*command exited with code\s+\d+/i.test(t)) return true;
  // Git 警告（非错误）
  if (t.includes("lf will be replaced by crlf")) return true;
  if (t.includes("lf would be replaced by crlf")) return true;
  // 纯空白或仅特殊字符
  if (/^[\s\-.]*$/.test(t)) return true;
  // 编码乱码：非空白字符中问号占比 > 50%
  const nonSpace = t.replace(/\s/g, '');
  if (nonSpace.length > 0) {
    const qmarkCount = (nonSpace.match(/[?\uFFFD]/g) || []).length;
    if (qmarkCount / nonSpace.length > 0.3) return true;
  }
  return false;
}

/**
 * 记录一次失败，返回 { signature, count, strike }
 */
function recordFailure(record) {
  const id = record.id || nextId();
  const signature = record.signature || classifyError(record.tool, record.error);
  const entry = {
    ...record,
    id,
    signature,
    timestamp: record.timestamp || now(),
  };

  failureLog.set(id, entry);
  if (failureLog.size > MAX_RECORDS * 2) {
    const ids = [...failureLog.keys()].sort(
      (a, b) => (failureLog.get(a).timestamp || 0) - (failureLog.get(b).timestamp || 0)
    );
    for (const oldId of ids.slice(0, failureLog.size - MAX_RECORDS)) {
      const oldSig = failureLog.get(oldId)?.signature;
      failureLog.delete(oldId);
      if (oldSig) {
        const c = signatureCounts.get(oldSig) || 1;
        if (c <= 1) signatureCounts.delete(oldSig);
        else signatureCounts.set(oldSig, c - 1);
      }
    }
  }

  const count = (signatureCounts.get(signature) || 0) + 1;
  signatureCounts.set(signature, count);
  saveFailures();

  const strike = count % strikeThreshold === 0; // 每 N 次触发一次 strike
  return { id, signature, count, strike };
}

// ── LLM 分析 ──

/**
 * **首次分析**：给定一个新模式，生成修复规则
 */
async function analyzeNewPattern(ctx, record) {
  const args = record.args || "";
  const err = record.error || "";
  const prompt = [
    "你是一个 Agent 错误分析师。分析以下工具调用失败。",
    "",
    `工具: ${record.tool || "未知工具"}`,
    `参数: ${args.slice(0, 200)}${args.length > 200 ? "（已截断）" : ""}`,
    `错误: ${(err || "（无错误信息，仅知道调用失败）").slice(0, 300)}${err.length > 300 ? "（已截断）" : ""}`,
    "",
    "输出一个 JSON 对象（不要 markdown 包裹）：",
    `{"pattern":"模式名","fix":"一行中文修复指令","cause":"根因简述"}`,
    "",
    "模式名从以下选：file_not_found | syntax_error | encoding | timeout | auth | rate_limit | network_error | parse_error | sandbox_denied | edit_failure | validation | cmd_not_found | context_overflow | empty_result | ambiguous_match | unclassified",
    "",
    "要求：",
    "- 先分析根因：工具返回的错误，根本原因是什么？是否可修复？",
    "- fix 使用「必须」「禁止」等强制性措辞，不超过 40 字",
    "- cause 不超过 60 字",
    "- 如果分析不出 actionable 的修复，pattern 填 unclassified",
    "",
    "示例：",
    '输入: tool=read error="ENOENT: no such file C:\\\\a.txt"',
    '输出: {"pattern":"file_not_found","fix":"读文件前先stat确认路径是否存在 不存在则创建","cause":"路径指向的文件不存在"}',
    "",
    '输入: tool=bash error="\"bash\" is not recognized"',
    '输出: {"pattern":"cmd_not_found","fix":"Windows环境用PowerShell命令而非bash命令","cause":"当前运行环境是Windows PowerShell不支持bash"}',
    "",
    '输入: tool=web_fetch error="429 Too Many Requests"',
    '输出: {"pattern":"rate_limit","fix":"等待30秒后重试 避免高频调用同一API","cause":"API请求频率超过限制"}',
    "",
    '输入: tool=media_generate-image error="Validation failed: count must be number"',
    '输出: {"pattern":"validation","fix":"count参数必须传数字 禁止传字符串","cause":"count参数类型错误应为数字但传入了字符串"}',
    "",
    '输入: tool=read error="No meaningful content"',
    '输出: {"pattern":"unclassified","fix":"","cause":""}',
  ].join("\n");

  return callLLM(ctx, prompt);
}

/**
 * **对比式重分析**：旧规则没生效 → 分析原因 → 精炼规则
 */
async function analyzeWhyRuleFailed(ctx, record, existingRule) {
  const err = record.error || "";
  const patternEnum = "file_not_found | syntax_error | encoding | timeout | auth | rate_limit | network_error | parse_error | sandbox_denied | edit_failure | validation | cmd_not_found | context_overflow | empty_result | ambiguous_match | unclassified";
  const prompt = [
    "你是一个 Agent 规则审计师。以下规则之前被写入，但 Agent 仍然遇到了同样的失败。",
    "",
    `旧规则: ${existingRule.fix || "(无)"}`,
    `旧根因: ${existingRule.cause || "(无)"}`,
    `已发生: ${existingRule.occurrenceCount} 次`,
    "",
    `本次失败:`,
    `工具: ${record.tool || "未知工具"}`,
    `错误: ${(err || "（无错误信息，仅知道调用失败）").slice(0, 300)}${err.length > 300 ? "（已截断）" : ""}`,
    "",
    "请判断失败原因并输出 JSON：",
    '{"verdict":"refine|same","fix":"新的修复指令","cause":"新的根因","reason":"为什么旧规则没挡住"}',
    "",
    `verdict 含义：`,
    `- refine: 旧规则不够强 → 覆盖旧规则（如「建议用正斜杠」→「必须用正斜杠」）`,
    `- same: 旧规则正确，Agent 单纯执行时忽略了，不改规则`,
    `- 不存在 supplement：所有修改都通过 refine 覆盖旧规则，不需要独立新规则`,
    "",
    "要求：",
    "- fix 使用「必须」「禁止」等强制性措辞，不超过 40 字",
    "- cause 不超过 60 字",
    "- reason 不超过 40 字",
    "",
    "示例：",
    '旧规则: "读前先stat确认"',
    '新失败: read("/data/test.txt") → ENOENT（文件确实不存在）',
    '输出: {"verdict":"same","fix":"","cause":"","reason":"文件确实不存在 Agent按规则操作仍失败"}',
    "",
    '旧规则: "路径用正斜杠"',
    '新失败: read("C:\\data\\test.txt") → ENOENT',
    '输出: {"verdict":"refine","fix":"必须用正斜杠/ 禁止用反斜杠","cause":"Windows路径反斜杠在JSON字符串中需转义","reason":"建议性措辞→强制性措辞"}',
    "",
    '旧规则: "count参数必须传数字"',
    '新失败: media_generate-image({"count":"12"}) → count必须是数字',
    '输出: {"verdict":"refine","fix":"count必须传数字类型 禁止传字符串","cause":"count参数要求number类型传string会校验失败","reason":"旧规则没强调类型必须是number而非string"}',
  ].join("\n");


  return callLLM(ctx, prompt);
}

/**
 * 调用 utility 模型
 * @returns {Promise<{pattern:string,fix:string,cause:string,verdict?:string,reason?:string}|null>}
 */
async function callLLM(ctx, prompt) {
  try {
    const bus = ctx.bus;
    if (!bus || !bus.hasHandler?.("model:sample-text")) {
      if (!_llmUnavailableLogged) {
        _llmUnavailableLogged = true;
        ctx.log?.warn?.("[self-evolve] LLM analysis unavailable — model:sample-text handler not found, 仅计数");
      }
      return null;
    }

    const result = await bus.request("model:sample-text", {
      systemPrompt: "你是一个严谨的分析助手。只输出 JSON，不要多余说明，不要 markdown 包裹。",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 400,
      operation: "self-evolve:error-analysis",
      pluginId: ctx.pluginId,
    });

    const text = (result && typeof result === "object" ? result.text : result) || "";

    // 提取 JSON（正则兜底）
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      ctx.log?.warn?.("[self-evolve] LLM response contained no JSON:", text.slice(0, 100));
      return null;
    }

    // 预处理：将 JSON 字符串中未转义的反斜杠转义，避免解析失败
    const safeJson = jsonMatch[0].replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    const parsed = JSON.parse(safeJson);
    if (!parsed.pattern && !parsed.verdict) {
      ctx.log?.warn?.("[self-evolve] LLM response missing key fields:", JSON.stringify(parsed).slice(0, 100));
      return null;
    }
    return parsed;
  } catch (err) {
    ctx.log?.error?.("[self-evolve] LLM call failed:", err.message);
    return null;
  }
}

// ── 规则管理 ──

/**
 * 新增或精炼 fix rule
 * @param {object} parsed - LLM 返回的解析结果
 * @param {number} timestamp
 * @param {string} [existingPattern] - 已有的 pattern（精炼模式时传入）
 */
function upsertFixRule(parsed, timestamp, existingPattern) {
  // unclassified → 不创建规则
  if (parsed.pattern === "unclassified") return null;

  const pattern = existingPattern || parsed.pattern;
  if (!pattern) return null;

  const existing = fixRules.get(pattern);
  if (existing) {
    existing.lastSeen = timestamp;
    existing.occurrenceCount += 1;
    existing.cause = parsed.cause || existing.cause;
    existing.fix = parsed.fix || existing.fix;
    existing.refineCount = (existing.refineCount || 0) + 1;
    saveRules();
    return { rule: existing, isNew: false };
  }

  const rule = {
    pattern,
    label: parsed.label || parsed.pattern || "未知",
    fix: parsed.fix || "",
    cause: parsed.cause || "",
    firstSeen: timestamp,
    lastSeen: timestamp,
    occurrenceCount: 1,
    refineCount: 0,
    written: false,   // 是否已成功写入置顶记忆
    dismissed: false,  // 用户手动删除后自动标记，不再写入
  };
  fixRules.set(pattern, rule);
  saveRules();
  return { rule, isNew: true };
}

// ── Pinned Memory ──

/**
 * 生成 pinned memory 条目字符串
 * pinned.md 使用 `- ` 列表项，每条一行不能换行
 * 用 ⚠ 前缀替代 Markdown 标题，避免 `- ## heading` 畸形语法
 * @param {FixRule[]} rules
 * @returns {string}
 */
function formatPinnedRules(rules) {
  if (rules.length === 0) return "";
  return rules
    .filter(r => !r.dismissed)
    .map(r => {
      const displayPattern = r.pattern.includes(":") ? r.pattern.substring(r.pattern.indexOf(":") + 1) : r.pattern;
      return `⚠ ${displayPattern} → ${r.fix}（${r.cause || "原因未知"}）`;
    }).join("\n");
}

function formatSingleRule(r) {
  const displayPattern = r.pattern.includes(":") ? r.pattern.substring(r.pattern.indexOf(":") + 1) : r.pattern;
  return `⚠ ${displayPattern} → ${r.fix}（${r.cause || "原因未知"}）`;
}

/**
 * 同步 fix rules 到 pinned memory
 */
async function syncPinnedMemory(ctx, force = false) {
  const nowTs = Date.now();
  if (!force && nowTs - lastPinnedSync < PINNED_SYNC_COOLDOWN_MS) return;
  lastPinnedSync = nowTs;

  const rules = [...fixRules.values()]
    .filter(r => r.pattern !== "unclassified")
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  // 过滤掉已驳回的，剩下的才需要同步
  const activeRules = rules.filter(r => !r.dismissed);
  if (activeRules.length === 0) return;

  try {
    const homeDir = process.env.USERPROFILE || homedir();
    const siPath = join(homeDir, ".hanako", "server-info.json");
    let token = "";
    let port = 0;
    try {
      const si = JSON.parse(readFileSync(siPath, "utf-8"));
      if (si.token) token = si.token;
      if (si.port) port = si.port;
    } catch { /* token-less fallback */ }

    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // 从 activeRules 提取所有 agentId（规则 key 格式: {agentId}:{tool}_{pattern}）
    const agentIds = [...new Set(activeRules.map(r => {
      const idx = r.pattern.indexOf(':');
      return idx > 0 ? r.pattern.substring(0, idx) : null;
    }).filter(Boolean))];
    if (agentIds.length === 0) {
      ctx.log?.debug?.("[self-evolve] no agentIds derived from rules, skip pinned sync");
      return;
    }

    let totalWritten = 0;
    let totalSkipped = 0;

    for (const agentId of agentIds) {
      const agentRules = activeRules.filter(r => r.pattern.startsWith(agentId + ':'));
      if (agentRules.length === 0) continue;

      try {
        // GET 该 agent 的当前置顶记忆
        const getRes = await ctx.network.fetch(`${baseUrl}/api/pinned?agentId=${encodeURIComponent(agentId)}`, { headers });
        let existingPins = [];
        if (getRes.ok) {
          const body = await getRes.json();
          existingPins = Array.isArray(body?.pins) ? body.pins : [];
        } else if (getRes.status === 404) {
          ctx.log?.warn?.("[self-evolve] agent not found, skip: " + agentId);
          totalSkipped += agentRules.length;
          continue;
        } else {
          ctx.log?.warn?.("[self-evolve] GET pinned failed for agent " + agentId + ": " + getRes.status);
          totalSkipped += agentRules.length;
          continue;
        }

        // 提取该 agent 置顶记忆中所有规则的模式名（去 agentId 前缀）
        const pinnedPatterns = new Set();
        for (const p of existingPins) {
          const m = p.trim().match(/^⚠\s+(.+?)\s+→\s+/);
          if (m) pinnedPatterns.add(m[1].replace(/^[^:]+:/, ''));
        }

        let rulesChanged = false;
        const toWrite = [];

        for (const rule of agentRules) {
          const cleanPattern = rule.pattern.replace(/^[^:]+:/, '');
          const inPinned = pinnedPatterns.has(cleanPattern);

          if (rule.written && !inPinned) {
            // 曾经写入过但现在不在置顶记忆中 → 用户手动删除了 → 标记驳回
            rule.dismissed = true;
            rulesChanged = true;
            ctx.log?.info?.("[self-evolve] rule dismissed by user: " + rule.pattern);
            continue;
          }

          if (inPinned && !rule.written) { rule.written = true; rulesChanged = true; }

          toWrite.push(formatSingleRule(rule));
          if (!rule.written) { rule.written = true; rulesChanged = true; }
        }

        if (rulesChanged) { saveRules(); ctx.log?.debug?.("[self-evolve] rules state updated for " + agentId); }
        if (toWrite.length === 0) {
          ctx.log?.debug?.("[self-evolve] no new rules for agent " + agentId);
          continue;
        }

        // 移除旧 self-evolve 条目，写入新规则
        const filtered = existingPins.filter(p => {
          if (typeof p !== "string") return true;
          if (/^(?:- )?⚠\s+.+\s+→\s+.+/.test(p.trim())) return false;
          if (p.includes("工具调用经验") || p.includes("工具调用自进化规则")) return false;
          return true;
        });

        const putRes = await ctx.network.fetch(`${baseUrl}/api/pinned?agentId=${encodeURIComponent(agentId)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ pins: [...filtered, ...toWrite] }),
        });

        if (putRes.ok) {
          totalWritten += toWrite.length;
          const notifyEnabled = ctx.config?.get?.("enableSyncNotification");
          if (notifyEnabled && _initialSyncDone) {
            ctx.bus?.emit?.({
              type: "notification",
              title: "Self Evolve",
              body: `已同步 ${toWrite.length} 条修复规则到 ${agentId} 的置顶记忆`,
              agentId,
            });
          }
          ctx.log?.info?.("[self-evolve] pinned synced for " + agentId + ": " + toWrite.length + " rules");
        } else {
          ctx.log?.warn?.("[self-evolve] PUT pinned failed for agent " + agentId + ": " + putRes.status);
          totalSkipped += agentRules.length;
        }
      } catch (err) {
        ctx.log?.warn?.("[self-evolve] sync failed for agent " + agentId + ": " + err.message);
        totalSkipped += agentRules.length;
      }
    }

    if (totalWritten > 0 || totalSkipped > 0) {
      ctx.log?.info?.("[self-evolve] pinned sync complete: " + totalWritten + " written, " + totalSkipped + " skipped");
    }
  } catch (err) {
    ctx.log?.warn?.("[self-evolve] pinned sync failed:", err.message);
  }
}

// ── 处理失败 ──

// 轻量缓存：每 10 秒重读一次配置，用户改设置后无需重启插件
let lastConfigRead = 0;
const SENSITIVITY_CACHE = { "灵敏": 1, "适中": 2, "标准": 3 };
function refreshThreshold(ctx) {
  if (Date.now() - lastConfigRead < 10_000) return;
  lastConfigRead = Date.now();
  const raw = ctx.config?.get?.("strikeThreshold") ?? "适中";
  strikeThreshold = typeof raw === "number" ? raw : (SENSITIVITY_CACHE[raw] ?? 2);
  ctx.log?.debug?.("[self-evolve] config refreshed: raw=" + raw + " → strikeThreshold=" + strikeThreshold);
}

async function processFailure(ctx, record) {
  refreshThreshold(ctx);

  // 噪声过滤：无实际错误文本的失败直接丢弃
  if (isNoiseError(record.error)) {
    ctx.log?.debug?.("[self-evolve] noise filtered: " + (record.tool || "?") + " error.length=" + (record.error || "").length);
    return;
  }

  // 从 sessionPath 提取 agentId，隔离不同 agent 的错误签名
  // 路径格式: .../agents/{agentId}/sessions/{file}.jsonl
  const agentId = (record.sessionPath || "").split(sep).slice(-3, -2)[0] || "unknown";
  record.agentId = agentId;

  // 签名前缀 agentId，使不同 agent 的同类错误独立计数
  if (!record.signature) {
    const baseSig = classifyError(record.tool, record.error);
    record.signature = `${agentId}:${baseSig}`;
  }

  const { signature, count, strike } = recordFailure(record);
  ctx.log?.debug?.("[self-evolve] failure recorded: " + signature + " (count=" + count + ", strike=" + strike + ")");

  // 从带 agentId 前缀的签名中提取纯 pattern 名（{agentId}:{tool}_{pattern} → {pattern}）
  // 不能用 lastIndexOf("_") 分割，因为 tool 和 pattern 都可能含下划线
  const colonIdx = signature.indexOf(":");
  const baseSig = colonIdx >= 0 ? signature.substring(colonIdx + 1) : signature;
  const knownPatterns = ERROR_CLASSIFIERS.map(c => c.pattern);
  const patternOnly = knownPatterns.find(p => baseSig.endsWith("_" + p)) || "unclassified";
  if (DEFERRED_PATTERNS.has(patternOnly)) {
    if (count % Math.max(strikeThreshold * 2, 3) !== 0) return;
    ctx.log?.info?.("[self-evolve] deferred analysis: " + signature + " (count=" + count + ")");
  } else if (!strike) {
    return; // 非延迟模式，攒够 strikeThreshold 次才分析
  }

  const existingRule = fixRules.get(signature);

  // 频控
  const lastAnalysis = analyzedSignatures.get(signature);
  if (lastAnalysis && (Date.now() - lastAnalysis < ANALYZE_COOLDOWN_MS)) return;
  analyzedSignatures.set(signature, Date.now());

  // unclassified 每 10 次触发一次 LLM 分析（开放分类），其余跳过
  if (signature.endsWith("_unclassified")) {
    if (count % Math.max(strikeThreshold * 2, 3) !== 0) {
      ctx.log?.debug?.("[self-evolve] unclassified failure, skip:", signature);
      return;
    }
    ctx.log?.info?.("[self-evolve] unclassified periodic analysis: " + signature + " (count=" + count + ")");
  }

  // 短暂性模式（语法随手错/git 冲突/网络/权限等不可控）→ 只计数不分析
  if (EPHEMERAL_PATTERNS.has(patternOnly)) {
    ctx.log?.debug?.("[self-evolve] ephemeral failure, skip analysis:", signature);
    return;
  }

  if (existingRule) {
    if (existingRule.dismissed) {
      ctx.log?.debug?.("[self-evolve] dismissed rule, skip analysis:", signature);
      return;
    }

    // 第 N 次失败 + 已有规则 → 对比式重分析
    ctx.log?.info?.("[self-evolve] re-analyzing rule: " + signature + " (count=" + count + ")");
    const parsed = await analyzeWhyRuleFailed(ctx, record, existingRule);
    if (!parsed) return;

    if (parsed.verdict === "same") {
      // 规则正确，Agent 没执行 → 只累加计数
      existingRule.lastSeen = record.timestamp;
      existingRule.occurrenceCount += 1;
      saveRules();
      if (parsed.reason) ctx.log?.info?.("[self-evolve] reason:", parsed.reason);
      ctx.log?.info?.("[self-evolve] rule unchanged: " + signature + " (verdict=same)");
      return;
    }

    if (parsed.verdict === "refine") {
      // 精炼旧规则
      const result = upsertFixRule(parsed, record.timestamp, signature);
      if (result) {
        if (parsed.reason) ctx.log?.info?.("[self-evolve] reason:", parsed.reason);
        ctx.log?.info?.("[self-evolve] refined rule: " + signature + " → " + parsed.fix);
      }
    } else if (parsed.verdict === "supplement") {
      // 补充 = 覆盖旧规则（和 refine 行为一致），用原始 signature 避免孤儿规则
      const result = upsertFixRule(parsed, record.timestamp, signature);
      if (result) {
        if (parsed.reason) ctx.log?.info?.("[self-evolve] reason:", parsed.reason);
        ctx.log?.info?.("[self-evolve] refined rule: " + signature + " → " + parsed.fix);
      }
    }
  } else {
    // 第 N 次失败 + 无规则 → 首次分析
    ctx.log?.info?.("[self-evolve] first analysis: " + signature + " (count=" + count + ")");
    const parsed = await analyzeNewPattern(ctx, record);
    if (!parsed) return;

    const result = upsertFixRule(parsed, record.timestamp, signature);
    if (result) {
      ctx.log?.info?.("[self-evolve] new rule: " + signature + " (pattern=" + parsed.pattern + ")");
    }
  }

  // 同步到 pinned memory（force 绕过冷却，规则变更后立即写入）
  await syncPinnedMemory(ctx, true);
}

// ── Plugin 生命周期 ──

export default class Plugin {
  async onload() {
    const ctx = this.ctx;
    const { dataDir, log } = ctx;

    mkdirSync(dataDir, { recursive: true });
    persistPath = dataDir;
    rulesPath = join(dataDir, RULES_FILE);
    failuresPath = join(dataDir, FAILURES_FILE);

    loadPersisted();

    // 从配置读取触发灵敏度（默认 "适中" → 2 次）
    // 字符串枚举 → 内部数字映射
    const SENSITIVITY_MAP = { "灵敏": 1, "适中": 2, "标准": 3 };
    let rawThreshold = ctx.config?.get?.("strikeThreshold") ?? "适中";
    // 兼容旧版数字类型配置
    if (typeof rawThreshold === "number") {
      strikeThreshold = rawThreshold;
    } else {
      strikeThreshold = SENSITIVITY_MAP[rawThreshold] ?? 2;
    }
    try {
      const resolvedCfg = JSON.parse(readFileSync(join(dataDir, "config.resolved.json"), "utf-8"));
      const val = resolvedCfg.strikeThreshold;
      if (typeof val === "number" && val >= 1) strikeThreshold = val;
      else if (typeof val === "string" && SENSITIVITY_MAP[val]) strikeThreshold = SENSITIVITY_MAP[val];
    } catch {}

    // utility 模型可用性延迟到首次 callLLM 时检测
    // （server/index.ts 在 initPlugins 之后才注册 model:sample-text handler）
    log.info("[self-evolve] loaded: " + failureLog.size + " failures, " + fixRules.size + " rules");

    // 暴露内部状态
    ctx._selfEvolve = {
      failureLog,
      fixRules,
      signatureCounts,
      processFailure: (record) => processFailure(ctx, record),
      getRules: () => [...fixRules.values()],
      getFailures: (limit = 100) => [...failureLog.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit),
      getStats: () => Object.fromEntries([...signatureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    };

    // Bus handler
    if (ctx.bus?.handle) {
      this.register(ctx.bus.handle("self-evolve:report-failure", (payload = {}) => {
        if (!payload.tool) return { ok: false, error: "missing tool" };
        processFailure(ctx, {
          tool: payload.tool,
          args: payload.args || "",
          error: payload.error || "",
          timestamp: payload.timestamp || Date.now(),
          sessionPath: payload.sessionPath || ctx.sessionPath || "",
        });
        return { ok: true };
      }));
    }

    // ── 订阅 bus 事件：缓存 args，捕获 tool 执行错误 ──
    // tool_execution_start 带 args 但无 isError，tool_execution_end 带 isError 但无 args
    // 用 toolCallId 桥接两者
    if (ctx.bus?.subscribe) {
      this.register(ctx.bus.subscribe((event, sessionPath) => {
        if (event.type === "tool_execution_start" && event.toolCallId) {
          argsCache.set(event.toolCallId, event.args);
        }
        if (event.type === "tool_execution_end" && event.isError) {
          const args = event.toolCallId ? argsCache.get(event.toolCallId) : null;
          if (event.toolCallId) argsCache.delete(event.toolCallId);

          const errorText = event.error
            || (event.result && typeof event.result === "object"
              ? (event.result.error || event.result.message || event.result.text || event.result.result || JSON.stringify(event.result))
              : String(event.result || ""))
            || event.message
            || "";
          ctx.log?.debug?.("[self-evolve] tool error: " + event.toolName + " isError=" + event.isError + " error.length=" + errorText.length);
          const argsStr = args
            ? JSON.stringify(args).slice(0, 500)
            : String(event.args || event.input || "").slice(0, 500);

          processFailure(ctx, {
            tool: event.toolName || "unknown",
            args: argsStr,
            error: errorText,
            sessionPath: sessionPath || ctx.sessionPath || "",
            timestamp: Date.now(),
          });
        }
      }, { types: ["tool_execution_end", "tool_execution_start"] }));
    } else {
      log.warn?.("[self-evolve] bus.subscribe unavailable, tool errors will not be auto-captured");
    }

    setTimeout(async () => {
      await syncPinnedMemory(ctx);
      _initialSyncDone = true;
    }, 5000);
  }

  async onunload() {
    saveRules();
    saveFailures();
    this.ctx.log?.info?.("[self-evolve] unloaded: " + fixRules.size + " rules");
  }
}
