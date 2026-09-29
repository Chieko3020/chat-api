const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const moderation = require("./moderation");

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
});

// ── 加载角色 system prompt ─────────────────────────────────

function loadPrompt(name) {
  const file = path.join(__dirname, "..", "config", "prompts", `${name}.txt`);
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch (e) {
    console.error(`[chat-api] Failed to load prompt: ${name}`, e.message);
    return "";
  }
}

const PROMPTS = {
  march7th: loadPrompt("march7th"),
  evernight: loadPrompt("evernight"),
};

// ── 安全输出模板 ──────────────────────────────────────────

const SAFETY_FALLBACKS = [
  "这个话题咱不太懂呢，聊点别的吧~",
  "唔...让我想想怎么回答好呢，换个问题试试？",
  "啊哈哈，今天天气不错呢~",
  "三月只说她知道的事情哦，这个太偏门啦！",
];

// ── 输出安全审计 ──────────────────────────────────────────

function sanitizeOutput(text) {
  text = text.replace(/https?:\/\/\S+|www\.\S+\.\S+/gi, "[链接已移除]");

  if (text.length > 600) {
    text = text.substring(0, 600) + "\n\n（回复过长已截断）";
  }

  if (!text || text.trim().length === 0) {
    return SAFETY_FALLBACKS[Math.floor(Math.random() * SAFETY_FALLBACKS.length)];
  }

  return text;
}

// ── DeepSeek API 调用 ──────────────────────────────────────

/**
 * @param {string} message - 用户消息
 * @param {Array} history - 历史对话 [{role, content}, ...]
 * @param {string} model - 'march7th' | 'evernight'
 * @returns {Promise<{reply: string, tokens: number}>}
 */
async function chat(message, history = [], model = "march7th") {
  const systemPrompt = PROMPTS[model] || PROMPTS.march7th;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  const llmModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

  try {
    const completion = await client.chat.completions.create({
      model: llmModel,
      messages: messages,
      max_tokens: 200,
      temperature: 0.8,
      top_p: 0.9,
    });

    const reply = completion.choices[0]?.message?.content
      || SAFETY_FALLBACKS[Math.floor(Math.random() * SAFETY_FALLBACKS.length)];
    const tokens = completion.usage?.total_tokens || 0;

    // Track actual token usage for daily quota
    try {
      const { execSync } = require("child_process");
      execSync(
        `python3 -c "from daily_counter import increment as inc; inc('chat', 50000, amount=${tokens})"`,
        { cwd: "/home/ubuntu/qqbot", timeout: 3000 }
      );
    } catch (e) { /* fail silent */ }

    const sanitized = sanitizeOutput(reply);
    // 输出侧语义审核：DeepSeek 无 moderation 端点，用一次 flash 判别调用实现。
    // fail-open —— 审核不可用时不阻塞正常聊天。
    const gated = await moderation.gate(sanitized);
    return { reply: gated, tokens };
  } catch (err) {
    console.error("[deepseek] API error:", err.message);
    if (err.status === 400 && err.message?.includes("content")) {
      return {
        reply: "唔...这个话题我接不住啦，咱们换一个？~",
        tokens: 0,
      };
    }
    throw err;
  }
}

module.exports = { chat };
