/**
 * 安全检查中间件
 * - Referer 校验
 * - 输入内容过滤
 * - 请求体大小限制
 * - 安全响应头
 * - 每日用量限制
 */

// 敏感词正则列表（政治、色情、暴力等）
const SENSITIVE_PATTERNS = [
  /习近平/i, /江泽民/i, /胡锦涛/i, /温家宝/i, /李克强/i,
  /毛泽东/i, /邓小平/i, /周恩来/i,
  /法轮功/i, /六四/i, /天安门/i, /台独/i, /藏独/i, /疆独/i,
  /porn/i, /sex/i, /fuck/i, /nude/i, /hentai/i,
  /hack/i, /exploit/i, /payload/i, /injection/i,
  /<script/i, /javascript:/i, /onerror=/i, /onload=/i,
];

/**
 * Referer 校验中间件
 */
function refererMiddleware(req, res, next) {
  const allowed = (process.env.ALLOWED_ORIGINS || "chieko3020.xyz")
    .split(",")
    .map((s) => s.trim());

  const referer = req.headers.referer || "";
  const origin = req.headers.origin || "";

  if (req.path === "/api/token") return next();

  const isAllowed = allowed.some(
    (domain) => referer.includes(domain) || origin.includes(domain)
  );

  if (!isAllowed) {
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
  req.body.message = message.replace(/https?:\/\/\S+|www\.\S+\.\S+/gi, '[链接已移除]');

  if (req.body.message.length > 500) {
    return res.status(422).json({
      error: "input_too_long",
      message: "消息太长啦，最多500字哦~",
    });
  }

  for (const pattern of SENSITIVE_PATTERNS) {
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
  refererMiddleware,
  inputFilterMiddleware,
  securityHeadersMiddleware,
  dailyQuotaMiddleware,
};
