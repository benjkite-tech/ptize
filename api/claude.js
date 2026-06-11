// api/claude.js — Vercel serverless function (Node runtime)
//
// Holds your Anthropic Console key SERVER-SIDE so it never reaches the browser.
// Ptize's frontend calls /api/claude; this function adds the key and forwards
// to Anthropic. The key lives in a Vercel Environment Variable named
// ANTHROPIC_API_KEY — never in this file, never in the repo, never in the client.
//
// ── Setup ───────────────────────────────────────────────────────────────────
// 1. Put this file at  api/claude.js  in your Vercel project.
// 2. Vercel dashboard → Project → Settings → Environment Variables:
//      ANTHROPIC_API_KEY = sk-ant-...   (your Console key)
//      ALLOWED_MODELS    = claude-sonnet-4-6  (optional)
// 3. Redeploy. That's it.
//
// ── Guardrails in here (Console spend cap is still your hard backstop) ────────
//  • Per-IP rate limit (best-effort, in-memory — see note below)
//  • max_tokens clamped server-side so a tampered client can't request huge outputs
//  • model allow-list so only the models you intend can be called
//  • only POST, only from your own origin in production

const RATE = { windowMs: 60_000, max: 12 };   // 12 AI calls per IP per minute
const MAX_TOKENS_CEILING = 2200;               // hard clamp regardless of client ask
const hits = new Map();                        // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();          // crude memory guard
  return arr.length > RATE.max;
}

export default async function handler(req, res) {
  // CORS — lock to your own origins in production. '*' is fine while testing.
  const allowOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server not configured: missing ANTHROPIC_API_KEY" });

  // Best-effort per-IP rate limit. NOTE: serverless instances don't share memory,
  // so this caps per-instance, not globally. It's a speed bump, not a wall —
  // your Anthropic Console spend cap is the real ceiling.
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Slow down — too many requests. Try again in a minute." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { model, messages, max_tokens, context_url } = body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }

    // Optional: fetch the user's context website server-side and prepend its text.
    // Guards: http(s) only, no private/internal hosts (SSRF), 5s timeout, hard size caps.
    if (context_url && typeof context_url === "string" && /^https?:\/\//i.test(context_url)) {
      const blocked = /^(https?:\/\/)(localhost|127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[::1\]|.*\.internal\b)/i;
      if (!blocked.test(context_url)) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 5000);
          const page = await fetch(context_url, {
            signal: ctl.signal,
            redirect: "follow",
            headers: { "user-agent": "Mozilla/5.0 (compatible; PtizeContextBot/1.0)" }
          });
          clearTimeout(timer);
          if (page.ok) {
            const raw = (await page.text()).slice(0, 300000);
            const text = raw
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/&[a-z#0-9]+;/gi, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 5000);
            if (text && typeof messages[0].content === "string") {
              messages[0].content =
                "WEBSITE CONTEXT (fetched live from " + context_url + " — use it to tailor your response):\n" +
                text + "\n\n---\n\n" + messages[0].content;
            }
          }
        } catch { /* context fetch is best-effort; never block the AI call */ }
      }
    }

    const allowed = (process.env.ALLOWED_MODELS || "claude-sonnet-4-6")
      .split(",").map(s => s.trim());
    const useModel = allowed.includes(model) ? model : allowed[0];
    const tokens = Math.min(Number(max_tokens) || 1200, MAX_TOKENS_CEILING);

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: useModel, max_tokens: tokens, messages })
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy error", detail: String(err).slice(0, 200) });
  }
}
