# Chat API — 基于 DeepSeek 的博客 AI 聊天服务

- 为 Hexo 博客提供 AI 角色聊天功能，支持自定义 prompt
- Express.js + OpenAI SDK，通过 JWT + 严格 Origin/Referer 校验双重鉴权保护 API
- 分层安全过滤：确定性模式硬拦 + 语义敏感词运行时可配 + URL 移除 + 输入/输出长度限制 + 每日 50K token 配额
- 请求体限 2KB，速率限制每 IP 每 5 分钟 20 次聊天请求
- 通过 nginx 反代暴露，systemd 管理，Supervisor 备选
- 开发环境：Ubuntu 24.04 LTS, Node.js 22, Express 4

## 项目简介

博客的 Live2D 看板娘接入 AI 聊天功能。用户通过前端组件发起对话，请求经 nginx 反代到 chat-api，chat-api 调用 DeepSeek API 生成角色回复并返回。支持独立的 system prompt 配置。

服务部署在 127.0.0.1:3002，由 nginx 通过 `proxy_pass` 暴露为 `/api/chat`。

## 功能特性

### 核心功能
- **角色聊天**: 三月七（march7th）和长夜月（evernight）两种人格（示例配置），独立 system prompt
- **JWT 鉴权**: GET /api/token 签发 30 分钟 Token，POST /api/chat 验证 Token
- **Origin/Referer 严格校验**: 解析 hostname 后精确或子域名匹配，仅允许配置的来源访问，防跨站滥用

### 安全特性

分层设计——入口真实性是唯一真正有效的一层，其余为纵深防御：

```
① 入口真实性  严格 host 匹配（Origin 优先，Referer 回退）+ JWT(HS256, IP 绑定, 30min)
② CORE_PATTERNS    确定性技术模式：提示注入 / 危险命令 / 脚本注入 / 凭证探测
③ SEMANTIC_PATTERNS 语义敏感词：默认空，经 SENSITIVE_PATTERNS 或 config/sensitive.json 注入
④ 输出审核    LLM as judge：回复发出前过一次 flash 判别（可关，fail-open）
⑤ 成本封顶    express-rate-limit（每 IP 5min/20 次）+ 50K token 日配额
⑥ 响应头      nosniff / X-Frame-Options DENY / Referrer-Policy
```

- **Origin 严格匹配**：解析 hostname 后做精确或子域名匹配。**注意**：早期实现用
  `origin.includes(domain)` 子串匹配，可被 `https://chieko3020.xyz.evil.com`、
  `https://notchieko3020.xyz`、`https://evil.com/?x=chieko3020.xyz` 绕过，已修复并有回归测试。
- **输入过滤**：仅对确定性技术模式硬拦；语义敏感词不写死在源码（正则拦不住变形/谐音/多轮绕过，
  却会误伤正常技术讨论），改为运行时可配。
- **输出审核**：DeepSeek 没有 moderation 端点（只有服务端内联过滤，违规返回 400），
  因此用一次 flash 判别调用实现。默认 fail-open —— 审核不可用时不阻塞聊天。
  ⚠️ **不要指向本机 ai-gateway**：它是语义缓存网关，会把"相似" prompt 判为同一请求并复用答案，
  实测出现过"违规样本命中缓存的 allow=true 而放行"。
- **输出审计**：URL 移除、600 字符截断、异常回复兜底。
- **速率限制**：每 IP 每 5 分钟 20 次聊天，Token 端点 30 次。
- **每日配额**：50K token/天，由 Python daily_counter 跨服务共享。
- **请求体限**：express.json({ limit: "2kb" })。

### 测试

```bash
node test/test.js              # 25 用例：token/鉴权/过滤/安全头/Origin 绕过回归/分层过滤/JWT 算法
node test/test_moderation.js   # 17 用例：verdict 解析/故障降级/真实判别能力（需 API key）
```

### 测试

```bash
node test/test.js      # 25 用例：token/鉴权/过滤/安全头/Origin 绕过回归/分层过滤/JWT 算法
```

## 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Node.js 22 |
| Web 框架 | Express 4 |
| LLM SDK | openai (OpenAI 兼容) |
| 鉴权 | jsonwebtoken |
| 频控 | express-rate-limit |
| LLM 后端 | DeepSeek v4-flash |

## 项目结构

```
chat-api/
├── server.js                 # Express 入口（路由 + 中间件）
├── services/
│   └── deepseek.js           # LLM API 客户端 + 角色 system prompt
├── middleware/
│   ├── auth.js               # JWT 签发与验证
│   └── security.js            # 安全过滤/Referer/频控/配额
├── config/
│   └── prompts/
│       ├── march7th.txt      # 三月七 system prompt
│       └── evernight.txt     # 长夜月 system prompt
├── public/
│   └── waifu-chat.js         # 前端聊天组件
├── .env / .env.example       # 环境变量
├── chat-api.service          # systemd 服务
├── DEPLOY.md                 # 部署文档
└── package.json
```

## 架构设计

```
Hexo 博客 (nginx :80/:443)
    │  POST /api/chat
    ▼
nginx (127.0.0.1:3002)
    │
    ▼
┌───────────────────────────────────┐
│  Express (3002)                   │
│  securityHeaders → json(2kb) →    │
│  rateLimit → referer → dailyQuota │
│  → auth → inputFilter → handler   │
│                                   │
│  handler:                         │
│    deepseek.chat(message, model)  │
│    ├─ march7th                    │
│    └─ evernight                   │
│                                   │
│  output:                          │
│    sanitizeOutput → response      │
└───────────────────────────────────┘
    │
    ▼
DeepSeek API (deepseek-v4-flash)
```

## 编译和运行

### 依赖

```bash
cd ~/chat-api
npm install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env 填入 DEEPSEEK_API_KEY 和 JWT_SECRET
```

### 启动

```bash
node server.js
# Listening on http://127.0.0.1:3002
```

### systemd 部署

```bash
sudo cp chat-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chat-api
```

## 配置项

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PORT` | 3002 | 监听端口 |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | api.deepseek.com/v1 | API 地址 |
| `DEEPSEEK_MODEL` | deepseek-v4-flash | 模型名称 |
| `JWT_SECRET` | — | JWT 签名密钥 |
| `ALLOWED_ORIGINS` | chieko3020.xyz | 允许的来源域名（逗号分隔）。严格 host 匹配，非子串包含 |
| `SENSITIVE_PATTERNS` | （空） | 语义敏感词兜底，逗号分隔的正则片段，默认不启用 |
| `MODERATION_ENABLED` | 1 | 输出审核开关 |
| `MODERATION_URL` | 官方 chat/completions | 审核端点。**勿指向 ai-gateway**（语义缓存会串答案） |
| `MODERATION_MODEL` | deepseek-flash | 审核模型 |
| `MODERATION_TIMEOUT_SEC` | 8 | 审核超时秒数 |
| `MODERATION_MAX_TOKENS` | 256 | 审核输出上限（推理模型需留余量） |
| `MODERATION_FAIL_MODE` | open | `open` 放行 / `closed` 拦截 |

## API

### GET /api/token
获取 JWT 访问令牌（30 分钟有效）

### POST /api/chat
```json
{ "message": "你好", "history": [], "model": "march7th" }
→ { "reply": "你好呀~", "model": "march7th" }
```

### GET /ping
健康检查
