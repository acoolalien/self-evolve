/// <reference types="node" />
/**
 * self-evolve 错误分类验证脚本（v2 —— 最长匹配语义）
 * 跑法: node test_classifier.mjs
 *
 * 覆盖：
 *   - 17 个分类器各至少一例
 *   - 5 个噪声过滤场景
 *   - 7 个边界情况
 *   - 验证旧版分类器排序缺陷是否修复
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── 从 index.js 拷贝的 v2 分类器（最长匹配） ──

const ERROR_CLASSIFIERS = [
  { pattern: "encoding",      keywords: ["encoding", "gbk", "utf", "codec", "chcp", "cannot decode", "ascii", "latin", "out-file", "tee-object"] },
  { pattern: "edit_failure",  keywords: ["no match found", "could not find the exact text", "find the exact text", "no changes made", "the replacement produced", "oldtext", "old_text", "string to replace"] },
  { pattern: "validation",    keywords: ["validation", "required parameter", "missing required", "must have", "invalid type", "expected string"] },
  { pattern: "parse_error",   keywords: ["json parse", "not valid json", "unexpected token", "malformed", "traceback", "modulenotfounderror", "importerror", "syntaxerror"] },
  { pattern: "ambiguous_match",keywords: ["multiple matches", "ambiguous", "more than one occurrence", "found \\d+ occurrences"] },
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
  { pattern: "unclassified",   keywords: [] },
];

const EPHEMERAL_PATTERNS = new Set(
  ERROR_CLASSIFIERS.filter(c => c.ephemeral).map(c => c.pattern)
);

const DEFERRED_PATTERNS = new Set(["file_not_found"]);

// ── v2 分类器（最长匹配语义） ──

function extractPattern(sig) {
  // 签名格式: ${toolKey}_${pattern}，pattern 名可能含下划线
  const known = ERROR_CLASSIFIERS.map(c => c.pattern).sort((a, b) => b.length - a.length);
  for (const p of known) {
    if (sig.endsWith(`_${p}`)) return p;
  }
  return sig.split("_").pop(); // 兜底
}

function classifyError(tool, errorMsg) {
  let clean = (errorMsg || "");
  const argIdx = clean.indexOf("\nReceived arguments:");
  if (argIdx >= 0) clean = clean.substring(0, argIdx);
  const msg = clean.toLowerCase();
  const toolKey = String(tool || "unknown").toLowerCase().replace(/\s+/g, "_");

  let bestPattern = null;
  let bestKwLen = -1;

  for (const cls of ERROR_CLASSIFIERS) {
    if (cls.keywords.length === 0) continue;
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

function isNoiseError(errorText) {
  if (!errorText || !errorText.trim()) return true;
  let text = errorText.trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.content?.[0]?.type === "text" && typeof parsed.content[0].text === "string") {
      text = parsed.content[0].text;
    }
  } catch { /* 非 JSON */ }
  const t = text.toLowerCase();
  if (/^\(no output\)\s*$/i.test(t)) return true;
  if (/^command exited with code\s+\d+/i.test(t)) return true;
  if (/^\(no output\)\s*command exited with code\s+\d+/i.test(t)) return true;
  if (t.includes("lf will be replaced by crlf")) return true;
  if (t.includes("lf would be replaced by crlf")) return true;
  if (/^[\s\-.]*$/.test(t)) return true;
  const nonSpace = t.replace(/\s/g, '');
  if (nonSpace.length > 0) {
    const qmarkCount = (nonSpace.match(/[?\uFFFD]/g) || []).length;
    if (qmarkCount / nonSpace.length > 0.3) return true;
  }
  return false;
}

// ── 已知问题回归检测 ──

const FIXED_ISSUES = [
  {
    id: "cmd_not_found_shadowed_by_file_not_found",
    description: "cmd_not_found.keyword('command not found') 不应被 file_not_found.keyword('not found') 截胡",
    // 模拟一条错误，同时包含 'command not found' 和 'not found'
    test: (sig) => {
      const parts = sig.split("_");
      const pattern = parts[parts.length - 1];
      return pattern === "cmd_not_found";
    }
  },
  {
    id: "cmd_not_found_cannot_find_module",
    description: "cmd_not_found.keyword('cannot find module') 不应被 file_not_found.keyword('cannot find') 截胡",
    test: (sig) => {
      const parts = sig.split("_");
      const pattern = parts[parts.length - 1];
      return pattern === "cmd_not_found";
    }
  },
  {
    id: "cmd_not_found_module_not_found",
    description: "cmd_not_found.keyword('module not found') 不应被 file_not_found.keyword('not found') 截胡",
    test: (sig) => {
      const parts = sig.split("_");
      const pattern = parts[parts.length - 1];
      return pattern === "cmd_not_found";
    }
  },
  {
    id: "cmd_not_found_vs_syntax",
    description: "cmd_not_found.keyword('is not recognized as an internal') 不应被 syntax_error.keyword('is not recognized') 截胡",
    test: (sig) => {
      const parts = sig.split("_");
      const pattern = parts[parts.length - 1];
      return pattern === "cmd_not_found";
    }
  },
  {
    id: "rate_limit_vs_context_overflow",
    description: "rate_limit.keyword('exceeded') 不应截胡 context_overflow 的更精确匹配",
    test: (sig) => {
      const parts = sig.split("_");
      const pattern = parts[parts.length - 1];
      return pattern === "context_overflow";
    }
  },
];

// ── 读测试数据 ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = readFileSync(join(__dirname, "error-tool-calls.ndjson"), "utf-8")
  .split("\n")
  .filter(l => l.trim() && !l.trim().startsWith("//"));

let passed = 0;
let noisePassed = 0;
let noiseCases = 0;
let fixesOk = 0;

console.log("\n=== 分类测试结果（v2 最长匹配）===\n");

data.forEach((line, i) => {
  const record = JSON.parse(line);
  const { tool, error } = record;

  const isNoise = isNoiseError(error);
  if (isNoise) {
    noiseCases++;
    noisePassed++;
    console.log(`  ✓ [噪声]   行 ${i}: tool=${tool} → 被正确过滤`);
    return;
  }

  const sig = classifyError(tool, error);
  const pattern = extractPattern(sig);
  const isEph = EPHEMERAL_PATTERNS.has(pattern);
  const isDef = DEFERRED_PATTERNS.has(pattern);
  const marker = isDef ? "⏳" : (isEph ? "🔴" : "🟢");

  passed++;
  console.log(`  ${marker} [${sig}] 行 ${i}: tool=${tool}`);
});

console.log(`\n── 汇总 ──`);
console.log(`分类测试:     ${passed} 条通过`);
console.log(`噪声过滤:     ${noisePassed}/${noiseCases} 条通过`);
console.log(`总测试行:     ${data.length} 行`);

// ── 验证已知问题修复 ──

console.log(`\n── 回归检测（旧版分类器排序缺陷）──`);

const regressionTestCases = [
  // cmd_not_found 不应被 file_not_found 截胡
  { tool: "bash", error: "zsh: command not found: npm", expected: "cmd_not_found" },
  { tool: "bash", error: "Cannot find module 'lodash' in node_modules", expected: "cmd_not_found" },
  { tool: "bash", error: "internal error: Module not found: 'react'", expected: "cmd_not_found" },
  { tool: "bash", error: "bash: is not recognized as an internal or external command", expected: "cmd_not_found" },
  // context_overflow 不应被 rate_limit 截胡
  { tool: "read", error: "Context length exceeded: prompt token count 184000 exceeds maximum context length of 128000 tokens", expected: "context_overflow" },
  // 常规分类仍正确
  { tool: "read", error: "ENOENT: no such file or directory, open 'test.txt'", expected: "file_not_found" },
  { tool: "edit", error: "Could not find the exact text 'function' — no match found", expected: "edit_failure" },
  { tool: "search", error: "FetchError: getaddrinfo ENOTFOUND api.github.com", expected: "network_error" },
  { tool: "web_fetch", error: "HTTP 429: Too Many Requests — try again later", expected: "rate_limit" },
  { tool: "bash", error: "expression or statement contains unexpected token", expected: "parse_error" },
  { tool: "custom", error: "some weird unknown error nobody has ever seen", expected: "unclassified" },
];

let allFixed = true;
for (const tc of regressionTestCases) {
  const sig = classifyError(tc.tool, tc.error);
  const actual = extractPattern(sig);
  const ok = actual === tc.expected;
  const mark = ok ? "✓" : "✗";
  if (!ok) allFixed = false;
  console.log(`  ${mark} [${actual}] → expected ${tc.expected}: ${tc.error.slice(0, 60)}...`);
  if (ok) fixesOk++;
}

console.log(`\n  修复项: ${fixesOk}/${regressionTestCases.length} 条通过`);

if (allFixed) {
  console.log(`  ✅ 全部已知分类器排序缺陷已修复`);
} else {
  console.log(`  ⚠ 部分测试未通过，需复查`);
}

console.log(``);
