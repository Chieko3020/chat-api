/**
 * waifu-chat.js
 * Chieko3020 Blog — Live2D 看板娘 DeepSeek 聊天功能
 * 使用方法：在博客 HTML 中，waifu-tips.js 之后引入本文件
 * API_BASE 和 MODEL 通过 data 属性在 <script> 标签上配置
 */
(function () {
  "use strict";

  // ── 配置 ──────────────────────────────────────────────
  const SCRIPT = document.currentScript;
  const API_BASE = SCRIPT?.dataset?.apiBase || "https://chat.chieko3020.xyz";
  const MODEL = SCRIPT?.dataset?.model || "march7th"; // 'march7th' | 'evernight'
  const CHAT_API = API_BASE + "/api/chat";
  const TOKEN_API = API_BASE + "/api/token";

  // ── 状态 ──────────────────────────────────────────────
  let token = null;
  let tokenExpiry = 0;
  let chatHistory = []; // [{role, content}, ...] 存 sessionStorage
  let isWaiting = false;

  // ── SessionStorage 持久化 ─────────────────────────────
  function saveHistory() {
    try {
      sessionStorage.setItem("waifu-chat-history", JSON.stringify(chatHistory));
    } catch (_) { /* ignore quota errors */ }
  }

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem("waifu-chat-history");
      if (raw) chatHistory = JSON.parse(raw);
    } catch (_) { /* ignore */ }
  }

  // ── Token 管理 ────────────────────────────────────────
  async function getToken() {
    if (token && Date.now() < tokenExpiry - 60000) return token; // 还有 1min 有效

    try {
      const resp = await fetch(TOKEN_API, { credentials: "omit" });
      if (!resp.ok) throw new Error("token fetch failed: " + resp.status);
      const data = await resp.json();
      token = data.token;
      tokenExpiry = Date.now() + (data.expires_in || 1800) * 1000;
      return token;
    } catch (err) {
      console.error("[waifu-chat] 获取 token 失败:", err.message);
      return null;
    }
  }

  // ── 发送消息 ──────────────────────────────────────────
  async function sendMessage(message) {
    const t = await getToken();
    if (!t) {
      showReply("唔…我现在连接不上，等一下再试试？");
      return;
    }

    // 准备历史（不含本条，控制总长度）
    const historySlice = chatHistory.slice(-8); // 最多 8 轮上下文

    try {
      const resp = await fetch(CHAT_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + t,
        },
        body: JSON.stringify({
          message: message,
          history: historySlice,
          model: getCurrentModel(),
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        showReply(data.message || "出错了…待会再试吧~");
        return;
      }

      showReply(data.reply);

      // 更新历史（只在成功时）
      chatHistory.push({ role: "user", content: message });
      chatHistory.push({ role: "assistant", content: data.reply });
      // 保持最多 14 条（7 轮）
      if (chatHistory.length > 14) chatHistory = chatHistory.slice(-14);
      saveHistory();
    } catch (err) {
      console.error("[waifu-chat] 发送失败:", err.message);
      showReply("呜呜，网络不太好…再试一次？");
    }
  }

  // ── 获取当前加载的模型 ───────────────────────────────
  function getCurrentModel() {
    try {
      const modelId = localStorage.getItem("modelId");
      // modelId: 0 = EverNight(长夜月), 1 = March7th(三月七)
      return modelId === "0" ? "evernight" : "march7th";
    } catch (_) {
      return MODEL;
    }
  }

  // ── 显示回复 ──────────────────────────────────────────
  function showReply(text) {
    // 复用 waifu-tips.js 的 tips 气泡机制
    // tips 气泡显示在 #waifu-tips 元素中
    const tips = document.getElementById("waifu-tips");
    if (!tips) return;

    tips.innerHTML = text;
    tips.classList.add("waifu-tips-active");

    // 8 秒后自动消失
    setTimeout(() => {
      if (tips.innerHTML === text) {
        tips.classList.remove("waifu-tips-active");
      }
    }, 8000);

    // 清除 sessionStorage 中的 tips 状态（waifu-tips.js 用它控制防重复）
    sessionStorage.removeItem("waifu-text");
  }

  // ── 聊天气泡输入框 ────────────────────────────────────
  function createChatBubble() {
    // 移除旧气泡
    const old = document.getElementById("waifu-chat-bubble");
    if (old) old.remove();

    const bubble = document.createElement("div");
    bubble.id = "waifu-chat-bubble";
    bubble.innerHTML = `
      <div class="waifu-chat-inner">
        <textarea id="waifu-chat-input"
          placeholder="和三月七说说话吧~"
          rows="2"
          maxlength="1000"></textarea>
        <div class="waifu-chat-actions">
          <button id="waifu-chat-clear" title="清除对话">🗑</button>
          <button id="waifu-chat-send">发送 ✈</button>
        </div>
      </div>
    `;
    document.body.appendChild(bubble);

    const input = document.getElementById("waifu-chat-input");
    const sendBtn = document.getElementById("waifu-chat-send");
    const clearBtn = document.getElementById("waifu-chat-clear");

    // 发送
    function doSend() {
      const msg = input.value.trim();
      if (!msg || isWaiting) return;
      isWaiting = true;
      input.disabled = true;
      sendBtn.textContent = "…";
      sendMessage(msg).finally(() => {
        isWaiting = false;
        input.value = "";
        input.disabled = false;
        sendBtn.textContent = "发送 ✈";
        input.focus();
      });
    }

    sendBtn.addEventListener("click", doSend);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
      if (e.key === "Escape") {
        removeChatBubble();
      }
    });

    // 清除对话历史
    clearBtn.addEventListener("click", () => {
      chatHistory = [];
      sessionStorage.removeItem("waifu-chat-history");
      showReply("（聊天记录已清空，咱们重新开始吧~）");
    });

    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener("click", function closeBubble(e) {
        const b = document.getElementById("waifu-chat-bubble");
        if (!b) {
          document.removeEventListener("click", closeBubble);
          return;
        }
        if (!b.contains(e.target) && e.target.id !== "waifu-tool-hitokoto") {
          removeChatBubble();
          document.removeEventListener("click", closeBubble);
        }
      });
    }, 100);

    input.focus();
  }

  function removeChatBubble() {
    const b = document.getElementById("waifu-chat-bubble");
    if (b) b.remove();
  }

  function toggleChatBubble() {
    if (document.getElementById("waifu-chat-bubble")) {
      removeChatBubble();
    } else {
      createChatBubble();
    }
  }

  // ── 样式注入 ──────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("waifu-chat-styles")) return;
    const style = document.createElement("style");
    style.id = "waifu-chat-styles";
    style.textContent = `
      #waifu-chat-bubble {
        position: fixed;
        right: 100px;
        bottom: 140px;
        width: 280px;
        background: rgba(30, 30, 40, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 14px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
        z-index: 100001;
        padding: 12px;
        animation: waifuChatIn 0.25s ease-out;
      }
      /* 小屏幕时靠左 */
      @media (max-width: 768px) {
        #waifu-chat-bubble {
          left: 20px;
          right: auto;
          bottom: 120px;
          width: 260px;
        }
      }
      @keyframes waifuChatIn {
        from { opacity: 0; transform: translateY(10px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #waifu-chat-input {
        width: 100%;
        min-height: 56px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        color: #e0e0e0;
        font-size: 14px;
        padding: 10px;
        resize: none;
        outline: none;
        font-family: inherit;
        line-height: 1.5;
        box-sizing: border-box;
      }
      #waifu-chat-input:focus {
        border-color: rgba(140, 160, 255, 0.5);
        background: rgba(255, 255, 255, 0.08);
      }
      #waifu-chat-input::placeholder {
        color: rgba(255, 255, 255, 0.3);
      }
      .waifu-chat-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 8px;
      }
      .waifu-chat-actions button {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        color: #d0d0d0;
        font-size: 13px;
        padding: 5px 14px;
        cursor: pointer;
        transition: background 0.15s;
        font-family: inherit;
      }
      .waifu-chat-actions button:hover {
        background: rgba(255, 255, 255, 0.15);
      }
      #waifu-chat-clear {
        font-size: 14px;
        padding: 5px 8px;
      }
      #waifu-chat-send {
        background: rgba(100, 140, 255, 0.25) !important;
        border-color: rgba(100, 140, 255, 0.3) !important;
      }
      #waifu-chat-send:hover {
        background: rgba(100, 140, 255, 0.4) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ── 核心：patch 按钮 ──────────────────────────────────
  function patchButton(btn) {
    if (!btn || btn.dataset.chatPatched) return;
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.dataset.chatPatched = "1";
    newBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleChatBubble();
    });
    newBtn.title = "和看板娘聊天";
    console.log("[waifu-chat] 按钮已 patch");
  }

  // ── MutationObserver + 立即检查 ─────────────────────────
  function watchHitokotoButton() {
    // 先立即检查一次（初始化时按钮可能已存在）
    patchButton(document.getElementById("waifu-tool-hitokoto"));

    // 再用 MutationObserver 监听后续重建（模型切换时）
    const tryObserve = () => {
      const toolBar = document.getElementById("waifu-tool");
      if (!toolBar) {
        setTimeout(tryObserve, 200);
        return;
      }

      const observer = new MutationObserver(() => {
        patchButton(document.getElementById("waifu-tool-hitokoto"));
      });
      observer.observe(toolBar, { childList: true, subtree: true });
    };
    tryObserve();
  }

  // ── oml2d 菜单注入 ───────────────────────────────────
  function patchOml2dMenus() {
    const check = () => {
      const items = document.querySelectorAll(".oml2d-menus-item");
      if (items.length === 0) {
        setTimeout(check, 500);
        return;
      }

      // 找菜单容器
      const container = items[0].parentElement;
      if (!container || container.dataset.chatInjected) return;
      container.dataset.chatInjected = "1";

      // 创建聊天按钮，复用 oml2d 的样式
      const btn = document.createElement("div");
      btn.className = "oml2d-menus-item";
      btn.title = "和看板娘聊天";
      btn.innerHTML = '<svg viewBox="0 0 512 512" class="oml2d-icon"><path fill="currentColor" d="M512 240c0 114.9-114.6 208-256 208c-37.1 0-72.3-6.4-104.1-17.9c-11.9 8.7-31.3 20.6-54.3 30.6C73.6 471.1 44.7 480 16 480c-6.5 0-12.3-3.9-14.8-9.9c-2.5-6-1.1-12.8 3.4-17.4l.3-.3c1.1-1.2 2.8-3.1 4.9-5.7c4.1-5 9.6-12.4 15.2-21.6c10-16.6 19.5-38.4 21.4-62.9C17.7 326.8 0 285.1 0 240C0 125.1 114.6 32 256 32s256 93.1 256 208z"/></svg>';
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleChatBubble();
      });
      container.appendChild(btn);
      console.log("[waifu-chat] oml2d 聊天按钮已注入");
    };
    check();
  }

  // ── 初始化 ────────────────────────────────────────────
  function init() {
    loadHistory();
    injectStyles();
    watchHitokotoButton(); // waifu-tips 的按钮
    patchOml2dMenus();     // oml2d 的按钮
    console.log("[waifu-chat] 初始化完成 | API:", API_BASE, "| Model:", MODEL);
  }

  // DOM 就绪后启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
