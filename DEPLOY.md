# Chat API 部署指南

## 1. 前端集成（在博客源码中修改）

### 1.1 引入 waifu-chat.js

在博客主题或页面的 `</body>` 前、waifu-tips.js 加载之后添加：

```html
<script
  src="/live2d/waifu-chat.js"
  data-api-base="https://chat.chieko3020.xyz"
  data-model="march7th"
></script>
```

### 1.2 waifu-tips.json 添加聊天提示

在 `waifu-tips.json` 的 `message.default` 数组中追加以下几条 tips：

```json
"点一下右下角的聊天气泡，可以和咱聊天哦~",
"来跟咱说说话吧，点聊天气泡就好！",
"咱可以陪你聊天哦，试试看？",
"有什么想和咱聊的吗？点气泡按钮~"
```

### 1.3 部署 waifu-chat.js 到博客

将 `chat-api/public/waifu-chat.js` 复制到博客源码的 `source/live2d/` 目录下。
这样 `hexo generate` 后会自动输出到 `public/live2d/waifu-chat.js`。

---

## 2. 后端部署（服务器端）

### 2.1 配置环境变量

```bash
cp /home/ubuntu/chat-api/.env.example /home/ubuntu/chat-api/.env
# 编辑 .env，填入真实的 DEEPSEEK_API_KEY 和随机 JWT_SECRET
```

### 2.2 安装 systemd 服务

```bash
sudo cp /home/ubuntu/chat-api/chat-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable chat-api
sudo systemctl start chat-api
```

### 2.3 部署 SSL 证书 + nginx

上传腾讯云 SSL 证书文件到：
- `/home/ubuntu/nginx_conf/ssl/chat.chieko3020.xyz_bundle.crt`
- `/home/ubuntu/nginx_conf/ssl/chat.chieko3020.xyz.key`

然后测试并重载 nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 3. 验证

```bash
# 健康检查
curl https://chat.chieko3020.xyz/ping

# 获取 token
curl https://chat.chieko3020.xyz/api/token

# 测试聊天（替换 YOUR_TOKEN）
curl -X POST https://chat.chieko3020.xyz/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"message":"你好呀，介绍一下你自己？","model":"march7th"}'
```
