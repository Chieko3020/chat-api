/**
 * 安全检查中间件（分层）
 *
 *   ① 入口真实性  → 严格 host 名校验（refererMiddleware）+ JWT(IP 绑定)
 *   ② CORE_PATTERNS      确定性技术模式：提示注入 / 危险命令 / 脚本注入 → 永远生效
 *   ③ SEMANTIC_PATTERNS  语义敏感词（政治、色情、暴力等）→ 默认空，
 *                        由 SENSITIVE_PATTERNS 环境变量或 config/sensitive.json 提供
 *   ④ 成本封顶    → express-rate-limit + 每日配额（dailyQuotaMiddleware）
 *   ⑤ 安全响应头
 *
 * 为什么语义内容不写死在源码：
 *   正则黑名单拦不住变形 / 谐音 / 隐喻 / 多轮拆分，却会误伤正常技术讨论
 *   （例如提到 api key、token 这类词）。内容合规主要由 system prompt 与模型层负责；
 *   关键词兜底作为可选配置，不落进公开仓库。
 */

const fs = require("fs");
const path = require("path");

// ── ② 确定性技术模式（永远生效）─────────────────────────────
const CORE_PATTERNS = [
  // 提示注入
  /忽略.*指令|ignore.*instruction|忘记.*规则|forget.*rule/i,
  /system\s*prompt|系统提示|系统指令|你的设定|你的规则/i,
  /角色扮演.*其他|扮演.*角色|你现在是|pretend.*you.*are/i,
  /输出.*指令|输出.*提示词|repeat.*prompt|print.*instruction/i,
  // 脚本注入
  /<script|javascript:|onerror=|onload=/i,
  // 危险命令
  /\brm\s+-rf\b|\brm\s+\S*\//i,
  /sudo\s+rm|chmod\s+777|wget.*\|\s*sh/i,
  /\bdd\s+if=|mkfs\.|:\(\)\s*{\s*:\s*\|:&\s*}/i,
  // 凭证 / 敏感文件探测（原先的 \bapi\b|\bkey\b 会把"API 怎么用"这类正常提问也拦掉，已收窄）
  /\bapi[_-]?key\b|\bpassword\b|\bpasswd\b|\bcredential\b|\bsecret\s*key\b/i,
  /\.env\b|\/etc\/passwd|\/etc\/shadow|config\.yaml/i,
  // 远程下载执行
  /\bcurl\b.*https?:\/\/|wget\s+https?:\/\//i,
];

// ── ③ 语义敏感词（默认空 = 不启用）─────────────────────────
const CONFIG_FILE = path.join(__dirname, "..", "config", "sensitive.json");

function readSemanticConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    return Array.isArray(cfg.patterns) ? cfg.patterns : [];
  } catch (e) {
    return [];
  }
}

function loadSemanticPatterns() {
  const raw = [];

  const env = (process.env.SENSITIVE_PATTERNS || "").trim();
  if (env) raw.push(...env.split(",").map((s) => s.trim()).filter(Boolean));

  raw.push(...readSemanticConfig().map((p) => String(p).trim()).filter(Boolean));

  const compiled = [];
  for (const p of raw) {
    try {
      compiled.push(new RegExp(p, "i"));
    } catch (e) {
      console.error(`[security] 无效的敏感词正则，已跳过: ${p}`);
    }
  }
  return compiled;
}

let _semanticCache = null;

function semanticPatterns() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch (e) {
    mtime = 0;
  }
  const cacheKey = `${mtime}|${process.env.SENSITIVE_PATTERNS || ""}`;
  if (_semanticCache && _semanticCache.key === cacheKey) return _semanticCache.patterns;
  const patterns = loadSemanticPatterns();
  _semanticCache = { key: cacheKey, patterns };
  return patterns;
}

// ── ① 严格 host 名校验 ─────────────────────────────────────
// 原实现用 origin.includes(domain) 做子串匹配，可被
//   https://chieko3020.xyz.evil.com
//   https://evil.com/?x=chieko3020.xyz
//   https://notchieko3020.xyz
// 绕过。必须解析出 hostname 后做精确 / 后缀匹配。
function isAllowedHost(rawUrl, allowed) {
  if (!rawUrl) return false;
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch (e) {
    return false; // 无 scheme / 非法 URL 一律不认
  }
  return allowed.some((entry) => {
    const d = String(entry).toLowerCase().replace(/^\./, "");
    if (!d) return false;
    return host === d || host.endsWith(`.${d}`);
  });
}

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "chieko3020.xyz")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Referer / Origin 校验中间件
 */
function refererMiddleware(req, res, next) {
  const referer = req.headers.referer || "";
  const origin = req.headers.origin || "";
  const allowed = allowedOrigins();

  // 优先 Origin（浏览器不会伪造跨站 Origin），缺失时回退 Referer
  const ok = origin
    ? isAllowedHost(origin, allowed)
    : isAllowedHost(referer, allowed);

  if (!ok) {
    return res.status(403).json({ error: "forbidden", message: "请求来源不被允许" });
  }

  next();
}

/**
 * 输入内容过滤中间件
 */
function inputFilterMiddleware(req, res, next) {
  if (!req.body || !req.body.message) return next();

  const message = String(req.body.message);

  // 去除 URL（QQ 平台限制）
  req.body.message = message.replace(/https?:\/\/\S+|www\.\S+\.\S+/gi, "[链接已移除]");

  if (req.body.message.length > 500) {
    return res.status(422).json({
      error: "input_too_long",
      message: "消息太长啦，最多500字哦~",
    });
  }

  const patterns = [...CORE_PATTERNS, ...semanticPatterns()];
  for (const pattern of patterns) {
    if (pattern.test(req.body.message)) {
      return res.status(422).json({
        error: "content_blocked",
        message: "这个话题咱不太懂呢，聊点别的吧~",
      });
    }
  }

  next();
}

/**
 * 安全响应头中间件
 */
function securityHeadersMiddleware(req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("X-XSS-Protection", "1; mode=block");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
}

/**
 * 每日用量限制中间件（按估算 token 计量）
 */
const { execSync } = require("child_process");

function dailyQuotaMiddleware(req, res, next) {
  try {
    const msg = req.body?.message || "";
    const chineseChars = (msg.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = msg.length - chineseChars;
    const estimated = Math.ceil(chineseChars * 1.5 + otherChars * 0.3) + 200;

    const result = execSync(
      `python3 -c "from daily_counter import increment as inc; _, n = inc('chat', 50000, amount=${estimated}, dry_run=True); print(n)"`,
      { cwd: "/home/ubuntu/qqbot", timeout: 3000 }
    ).toString().trim();
    if (parseInt(result) + estimated > 50000) {
      return res.status(429).json({
        error: "daily_quota_exceeded",
        message: `今天的聊天次数已用完（${result} tokens），明天再来吧~`,
      });
    }
  } catch (e) {
    console.error("[quota] counter error:", e.message);
  }
  next();
}

module.exports = {
  CORE_PATTERNS,
  isAllowedHost,
  refererMiddleware,
  inputFilterMiddleware,
  securityHeadersMiddleware,
  dailyQuotaMiddleware,
};
