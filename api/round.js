// Vercel serverless function: open or close a voting round. Admin only. Closing re-checks every voter's balance.
// Set ADMIN_KEY in Vercel env vars (a long random string). Use admin.html, or:
//   POST /api/round  Authorization: Bearer <ADMIN_KEY>
//   { "action": "open", "number": 1, "title": "What should the agent build first?",
//     "options": ["Rug radar", "Agent treasury", "Smart money tracker"], "hours": 48, "min_tokens": 0 }
//   { "action": "close" }
const crypto = require("crypto");
const L = require("./_lib");

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
function authed(req) {
  const key = L.env("ADMIN_KEY");
  if (key.length < 16) return false;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (!authed(req)) return send(res, 401, { error: "Wrong admin key, or ADMIN_KEY is not set (16+ characters)." });
  if (!L.redisConf()) return send(res, 500, { error: "Storage not set up. Add Upstash for Redis in Vercel → Storage." });
  const mint = L.env("TOKEN_CA");
  if (!L.B58.test(mint)) return send(res, 500, { error: "TOKEN_CA is not set." });

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: "Bad JSON." }); }
  try {
    const cur = await L.redis("GET", "bv:round");
    const round = cur ? JSON.parse(cur) : null;

    if (body.action === "close") {
      if (!round) return send(res, 409, { error: "No round to close." });
      round.closed_at = round.closed_at || new Date().toISOString();
      const done = await L.finalizeRound(round, mint);
      return send(res, 200, { ok: true, round: done });
    }

    if (body.action === "open") {
      const number = parseInt(body.number, 10);
      const options = (Array.isArray(body.options) ? body.options : []).map((s) => String(s).trim()).filter(Boolean);
      if (!(number > 0)) return send(res, 400, { error: "Round number must be 1 or more." });
      if (options.length < 2 || options.length > 8) return send(res, 400, { error: "Give 2 to 8 options." });
      if (options.some((o) => o.length > 60 || /[\n\r]/.test(o))) return send(res, 400, { error: "Options must be one line, 60 characters max." });
      if (new Set(options).size !== options.length) return send(res, 400, { error: "Options must be different." });
      if (round && round.number >= number && (await L.redis("HLEN", "bv:votes:" + number)) > 0) {
        return send(res, 409, { error: "Round " + number + " already has votes. Use a new round number." });
      }
      const hours = Math.max(1, Math.min(24 * 14, Number(body.hours) || 48));

      const decimals = (await L.call("getTokenSupply", [mint])).value.decimals;
      const minUi = Math.max(0, Number(body.min_tokens) || 0);
      const now = new Date();
      const next = {
        number, options,
        title: String(body.title || "What should the agent build next?").slice(0, 120),
        open: true,
        opened_at: now.toISOString(),
        closes_at: new Date(now.getTime() + hours * 3600 * 1000).toISOString(),
        closed_at: null,
        min_ui: minUi,
        min_raw: minUi > 0 ? (BigInt(Math.round(minUi * 1e6)) * 10n ** BigInt(decimals) / 1000000n).toString() : null,
        decimals,
      };
      await L.redis("SET", "bv:round", JSON.stringify(next));
      return send(res, 200, { ok: true, round: next });
    }
    return send(res, 400, { error: "action must be open or close" });
  } catch (e) {
    return send(res, 500, { error: "Server error: " + e.message });
  }
};