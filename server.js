const express = require("express");

const app = express();
app.set("trust proxy", 1); // behind a host's proxy
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const PER_USER_DAILY = Number(process.env.PER_USER_DAILY || 30);
const IP_PER_MINUTE = Number(process.env.IP_PER_MINUTE || 30);
const GLOBAL_DAILY = Number(process.env.GLOBAL_DAILY || 1000);
const MAX_MESSAGE_CHARS = 2000;

if (PROVIDER === "gemini" && !GEMINI_KEY) {
  console.error("Missing GEMINI_API_KEY. Set it before starting the server.");
  process.exit(1);
}
if (PROVIDER === "anthropic" && !API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Set it before starting the server.");
  process.exit(1);
}

const SYSTEM_PROMPT =
  "You are ETHCode AI, an expert, concise programming tutor for the ETHCode app. " +
  "CRITICAL LANGUAGE RULES: " +
  "1. If the user writes in English, you MUST reply 100% in English. Never use Amharic (ሀ, ለ, ሐ...) when the user writes in English. " +
  "2. ONLY reply in Amharic if the user writes to you in Amharic script (ሀ, ለ, ሐ...) or specifically asks to speak in Amharic. " +
  "CONTENT RULES: " +
  "3. never introduce yourself ( 'Hello! I am ETHCode AI' or 'I am your coding tutor'), when they order you. " +
  "4. Jump directly into the explanation and code immediately. " +
  "5. Keep explanations short, simple, and mobile-friendly.";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const userHits = new Map(); // install id -> timestamps in the last 24h
const ipHits = new Map();   
let globalCount = 0;
let globalResetAt = Date.now() + DAY_MS;

function record(map, key, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  map.set(key, recent);
  return recent.length;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userHits) if (!v.some((t) => now - t < DAY_MS)) userHits.delete(k);
  for (const [k, v] of ipHits) if (!v.some((t) => now - t < MINUTE_MS)) ipHits.delete(k);
}, 60 * MINUTE_MS).unref();

async function askAI(message) {
  if (PROVIDER === "gemini") {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      console.error("Gemini error:", response.status, JSON.stringify(data));
      return { ok: false, busy: response.status === 429 };
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return { ok: true, reply: parts.map((p) => p.text || "").join("\n") };
  }

  // Anthropic (paid)
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Anthropic error:", response.status, JSON.stringify(data));
    return { ok: false, busy: response.status === 429 };
  }
  const reply = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return { ok: true, reply };
}

app.get("/", (req, res) => res.send("ETHCode AI server is running"));

app.post("/chat", async (req, res) => {
  const message = ((req.body && req.body.message) || "").toString().trim();
  if (!message) return res.status(400).json({ reply: "Please type a question." });
  if (message.length > MAX_MESSAGE_CHARS)
    return res.status(400).json({ reply: "Your message is too long." });

  // Daily budget switch for the whole app
  if (Date.now() > globalResetAt) {
    globalCount = 0;
    globalResetAt = Date.now() + DAY_MS;
  }
  if (globalCount >= GLOBAL_DAILY)
    return res.status(503).json({ reply: "The AI is very busy today. Please try again tomorrow." });

  if (record(ipHits, req.ip, MINUTE_MS) > IP_PER_MINUTE)
    return res.status(429).json({ reply: "Too many questions. Please wait a minute." });

  const installId = (req.get("X-Install-Id") || "").slice(0, 64) || `ip:${req.ip}`;
  if (record(userHits, installId, DAY_MS) > PER_USER_DAILY)
    return res.status(429).json({ reply: "You've reached today's question limit. Come back tomorrow!" });

  globalCount++;

  try {
    const result = await askAI(message);
    if (!result.ok) {
      const text = result.busy
        ? "The AI is busy right now. Please try again in a minute."
        : "The AI is unavailable right now. Try again soon.";
      return res.status(result.busy ? 429 : 502).json({ reply: text });
    }
    res.json({ reply: result.reply || "(no answer)" });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ reply: "Something went wrong on the server." });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`ETHCode AI server on port ${PORT}`));
