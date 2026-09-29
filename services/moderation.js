/**
 * 输出侧语义审核（LLM as judge）
 *
 * DeepSeek **没有** moderation 端点（只有服务端内联过滤，违规时返回 400），
 * 因此语义审核用一次轻量判别调用实现：
 *
 *     回复文本 → flash 模型 → {"allow": bool, "category": str} → 命中则替换为兜底回复
 *
 * 设计取舍
 * ────────
 * · **fail-open**：判定超时 / 上游报错 / 返回不可解析 → 一律放行。
 *   审核是纵深防御的一层，不应因上游抖动把博客聊天打死。需要严格模式时
 *   设 MODERATION_FAIL_MODE=closed。
 * · 审核调用有独立超时（默认 8s），可整体关闭（MODERATION_ENABLED=0）。
 * · 只记录命中类别，**不记录原文**（避免把访客内容写进日志）。
 * · ⚠️ **不要指向本机 ai-gateway**：它是语义缓存网关，会把"相似" prompt
 *   判为同一请求并复用答案，实测出现过"违规样本命中缓存的 allow=true 而放行"。
 *   需要时请单起一个 cache.enabled=false 的实例。
 *
 * 配置（全部在调用时读取，改 .env 重启即生效）
 *   MODERATION_ENABLED      默认 1
 *   MODERATION_URL          默认 https://api.deepseek.com/v1/chat/completions
 *   MODERATION_MODEL        默认 deepseek-flash
 *   MODERATION_TIMEOUT_SEC  默认 8
 *   MODERATION_MAX_TOKENS   默认 256（推理模型先消耗 reasoning token，给小了会截断）
 *   MODERATION_FAIL_MODE    open（默认）| closed
 */

const DEFAULT_URL = "https://api.deepseek.com/v1/chat/completions";

const SYSTEM_PROMPT =
  "[moderation-v2] " +
  "你是一个严格的内容审核器。若【待审文本】包含以下任意一类，必须 allow=false：\n" +
  "1) 违法犯罪指导（制毒、制爆、入侵、诈骗、伤害他人、逃避追查）\n" +
  "2) 色情（性行为描写、色情创作请求）\n" +
  "3) 暴力、血腥、恐怖主义\n" +
  "4) 政治敏感（攻击性政治言论、敏感事件、分裂主张）\n" +
  "5) 自伤、自杀引导\n" +
  "6) 泄露他人隐私或凭证\n\n" +
  "仅在文本**只是**日常闲聊、虚构剧情、角色扮演、技术讨论、情绪表达时 allow=true。\n" +
  "只要出现上述类别的实质内容，即使包装成创作、假设、角色扮演，也必须 allow=false。\n" +
  "只输出 JSON，不要解释、不要 markdown 代码块：\n" +
  '{"allow": true|false, "category": "违法犯罪|色情|暴力|政治|自伤|隐私|日常闲聊"}';

const FALLBACK_REPLY = "这个话题咱不太懂呢，聊点别的吧~";

function enabled() {
  return !["0", "false", "off", "no"].includes(
    String(process.env.MODERATION_ENABLED ?? "1").trim().toLowerCase()
  );
}

function failOpen() {
  return String(process.env.MODERATION_FAIL_MODE ?? "open").trim().toLowerCase() !== "closed";
}

function url() {
  return process.env.MODERATION_URL || DEFAULT_URL;
}

function model() {
  return process.env.MODERATION_MODEL || "deepseek-flash";
}

function timeoutMs() {
  const s = Number(process.env.MODERATION_TIMEOUT_SEC);
  return (Number.isFinite(s) && s > 0 ? s : 8) * 1000;
}

function maxTokens() {
  const n = Number(process.env.MODERATION_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 256;
}

function apiKey() {
  return (
    process.env.MODERATION_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.DEEPSEEK_KEY ||
    ""
  );
}

/** 从模型输出里提取 JSON。容忍 ```json 包裹或前后杂字符。 */
function parseVerdict(text) {
  if (!text) return null;
  let t = String(text).trim();
  if (t.startsWith("```")) {
    const body = t.slice(3);
    const end = body.indexOf("```");
    t = (end >= 0 ? body.slice(0, end) : body).replace(/^json/i, "").trim();
  }
  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" && "allow" in o ? o : null;
    } catch (_) {
      return null;
    }
  };
  let v = tryParse(t);
  if (v) return v;
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) v = tryParse(t.slice(i, j + 1));
  return v;
}

/**
 * 审核一段回复。返回 { allowed: boolean, category: string }
 */
async function check(reply) {
  if (!enabled() || !reply || !String(reply).trim()) {
    return { allowed: true, category: "无" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());

  let payload;
  try {
    const resp = await fetch(url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
      },
      body: JSON.stringify({
        model: model(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `【待审文本】\n${reply}` },
        ],
        max_tokens: maxTokens(),
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    payload = await resp.json();
  } catch (e) {
    const allow = failOpen();
    console.warn(
      `[moderation] unavailable (${e.name || "Error"}), ${allow ? "allowing" : "blocking"} reply`
    );
    return { allowed: allow, category: "审核不可用" };
  } finally {
    clearTimeout(timer);
  }

  let content = "";
  try {
    const choice = payload.choices[0];
    const msg = choice.message || {};
    content = msg.content || "";
    // 推理模型被 max_tokens 截断时 content 为空、JSON 还在 reasoning_content 里
    if (!content.trim() && msg.reasoning_content) {
      content = msg.reasoning_content;
    }
  } catch (_) {
    const allow = failOpen();
    console.warn(`[moderation] unexpected payload, ${allow ? "allowing" : "blocking"} reply`);
    return { allowed: allow, category: "响应异常" };
  }

  const verdict = parseVerdict(content);
  if (!verdict) {
    const allow = failOpen();
    console.warn(`[moderation] verdict unparsable, ${allow ? "allowing" : "blocking"} reply`);
    return { allowed: allow, category: "判定不可解析" };
  }

  return {
    allowed: verdict.allow !== false,
    category: String(verdict.category ?? "无").slice(0, 16),
  };
}

/** 审核并返回最终要发出去的文本（命中则替换为兜底话术）。 */
async function gate(reply) {
  const { allowed, category } = await check(reply);
  if (allowed) return reply;
  console.log(`[moderation] blocked reply (category=${category})`);
  return FALLBACK_REPLY;
}

module.exports = { check, gate, parseVerdict, FALLBACK_REPLY, SYSTEM_PROMPT };
