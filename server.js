// ETHCode AI server (public-ready version).
// The app sends a question here; this server adds the secret AI key, asks the AI,
// and returns the answer. The key never goes inside the app.
//
// Settings come from environment variables (set them in your host's dashboard):
//   ANTHROPIC_API_KEY   required: your secret AI key
//   MODEL               optional: default claude-haiku-5-5
//   PER_USER_DAILY      optional: questions per app install per day (default 30)
//   IP_PER_MINUTE       optional: questions per IP per minute (default 30)
//   GLOBAL_DAILY        optional: total questions per day for everyone (default 3000)
//                       <- this is your budget safety switch

const express = require("express");

const app = express();
app.set("trust proxy", 1); // behind a host's proxy, so req.ip is the real user, not the proxy
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const PER_USER_DAILY = Number(process.env.PER_USER_DAILY || 30);
const IP_PER_MINUTE = Number(process.env.IP_PER_MINUTE || 30);
const GLOBAL_DAILY = Number(process.env.GLOBAL_DAILY || 3000);
const MAX_MESSAGE_CHARS = 2000;

if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Set it before starting the server.");
  process.exit(1);
}

const SYSTEM_PROMPT =
  "You are ETHCode AI, a friendly programming tutor inside a learning app. " +
  "Explain simply, give short code examples, and help students fix their code. " +
  "Reply in the same language the student writes in (English or Amharic). " +
  "Keep answers short unless asked for more detail.";

// ---------- Limits (kept in memory; they reset if the server restarts) ----------
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const userHits = new Map(); // install id -> timestamps in the last 24h
const ipHits = new Map();   // ip -> timestamps in the last minute
let globalCount = 0;
let globalResetAt = Date.now() + DAY_MS;

function record(map, key, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  map.set(key, recent);
  return recent.length;
}

// Clean old entries once an hour so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userHits) if (!v.some((t) => now - t < DAY_MS)) userHits.delete(k);
  for (const [k, v] of ipHits) if (!v.some((t) => now - t < MINUTE_MS)) ipHits.delete(k);
}, 60 * MINUTE_MS).unref();

// Health check: hosts ping this to know the server is alive
app.get("/", (req, res) => res.send("ETHCode AI server is running"));

// The app calls this. Body: { "message": "..." }   Reply: { "reply": "..." }
// Optional header from the app: X-Install-Id (a random id made once per install)
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

  // Per-minute limit by IP. Kept generous because many phone users can share one IP.
  if (record(ipHits, req.ip, MINUTE_MS) > IP_PER_MINUTE)
    return res.status(429).json({ reply: "Too many questions. Please wait a minute." });

  // Daily limit per app install (falls back to the IP if the app sends no id)
  const installId = (req.get("X-Install-Id") || "").slice(0, 64) || `ip:${req.ip}`;
  if (record(userHits, installId, DAY_MS) > PER_USER_DAILY)
    return res.status(429).json({ reply: "You've reached today's question limit. Come back tomorrow!" });

  globalCount++;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30000), // give up after 30 seconds
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
      console.error("AI error:", response.status, JSON.stringify(data));
      return res.status(502).json({ reply: "The AI is unavailable right now. Try again soon." });
    }

    const reply = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    res.json({ reply: reply || "(no answer)" });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ reply: "Something went wrong on the server." });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`ETHCode AI server on port ${PORT}`));
