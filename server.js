require("dotenv").config();

const express = require("express");
const rateLimit = require("express-rate-limit");

const { authMiddleware, generateToken } = require("./middleware/auth");
const {
  refererMiddleware,
  inputFilterMiddleware,
  securityHeadersMiddleware,
  dailyQuotaMiddleware,
} = require("./middleware/security");
const { chat } = require("./services/deepseek");

const app = express();
const PORT = process.env.PORT || 3002;

// ── CORS 跨域 ────────────────────────────────────────────
app.use((req, res, next) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "chieko3020.xyz")
    .split(",")
    .map((s) => s.trim());

  const origin = req.headers.origin || "";
  const isAllowed = allowedOrigins.some((d) => origin.includes(d));

  if (isAllowed || !origin) {
    res.set("Access-Control-Allow-Origin", origin || "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// ── 全局中间件 ────────────────────────────────────────────
app.set("trust proxy", 1); // nginx 反代后获取真实 IP
app.use(securityHeadersMiddleware);
app.use(express.json({ limit: "2kb" })); // 限制请求体大小

// ── 速率限制 ──────────────────────────────────────────────
const tokenLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 分钟窗口
  max: 30, // token 端点宽松些
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "请求太频繁啦，请稍后再试~" },
});

const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20, // 聊天端点每 IP 每 5 分钟 20 次
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "你说得太快了，让我喘口气~" },
});

// ── 路由 ──────────────────────────────────────────────────

// GET /api/token — 获取 JWT 令牌
app.get("/api/token", refererMiddleware, tokenLimiter, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const token = generateToken(clientIP);

  res.json({
    token: token,
    expires_in: 1800, // 30 分钟
    token_type: "Bearer",
  });
});

// POST /api/chat — 聊天接口
app.post(
  "/api/chat",
  refererMiddleware,
  chatLimiter,
  dailyQuotaMiddleware,
  authMiddleware,
  inputFilterMiddleware,
  async (req, res) => {
    const { message, history, model } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(422).json({
        error: "empty_message",
        message: "发点什么嘛，别光看着~",
      });
    }

    try {
      const result = await chat(message.trim(), history || [], model || "march7th");

      // 日志记录（不含完整聊天内容以保护隐私）
      console.log(
        `[chat] IP=${req.ip} model=${model || "march7th"} tokens=${result.tokens} len=${message.length}`
      );

      res.json({
        reply: result.reply,
        model: model || "march7th",
      });
    } catch (err) {
      console.error("[chat] Error:", err.message);
      res.status(502).json({
        error: "api_error",
        message: "哎呀，我刚才走神了…再试一次吧！",
      });
    }
  }
);

// GET /ping — 健康检查
app.get("/ping", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// ── 启动 ──────────────────────────────────────────────────

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`[chat-api] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[chat-api] Allowed origins: ${process.env.ALLOWED_ORIGINS || "未设置"}`);
  console.log(`[chat-api] DeepSeek model: deepseek-chat (max_tokens=200)`);
});

// 优雅关闭
process.on("SIGTERM", () => {
  console.log("[chat-api] SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("[chat-api] SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});
