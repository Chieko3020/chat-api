const jwt = require("jsonwebtoken");

/**
 * JWT Token 鉴权中间件
 * 验证请求中的 token 是否有效（30min 过期 + IP 绑定）
 */
function authMiddleware(req, res, next) {
  // 从 Authorization header 或 query 参数中取 token
  const authHeader = req.headers.authorization;
  const token =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : (req.query && req.query.token);

  if (!token) {
    return res.status(401).json({ error: "missing_token", message: "请提供访问令牌" });
  }

  try {
    // 显式限定算法，避免算法混淆类攻击
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

    // IP 绑定验证
    const clientIP = req.ip || req.connection.remoteAddress;
    if (payload.ip && payload.ip !== clientIP) {
      return res.status(403).json({ error: "ip_mismatch", message: "令牌与IP不匹配" });
    }

    // 写入 req 供后续使用
    req._chatUser = payload;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "token_expired", message: "令牌已过期，请刷新页面" });
    }
    return res.status(403).json({ error: "invalid_token", message: "令牌无效" });
  }
}

/**
 * 生成 JWT token
 * @param {string} ip - 客户端 IP
 * @returns {string} JWT token
 */
function generateToken(ip) {
  return jwt.sign(
    {
      ip: ip,
      iat: Math.floor(Date.now() / 1000),
      jti: Math.random().toString(36).substring(2, 15),
    },
    process.env.JWT_SECRET,
    { expiresIn: "30m" }
  );
}

module.exports = { authMiddleware, generateToken };
