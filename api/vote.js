// Vercel serverless function: the public ballot box.
//   GET  /api/vote          current round and live tally
//   GET  /api/vote?full=1   plus every signed vote (message, signature, balances), so anyone can recount
//   POST /api/vote          { wallet, message, signature }  cast or replace a vote
// Weight: tokens held when voting, checked again when the round closes. The lower number counts.
// Needs: SOLANA_RPC_URL, TOKEN_CA, and Upstash Redis (see _lib.js).
const L = require("./_lib");

const MAX_AGE_MS = 10 * 60 * 1000;   // a signed message is valid for 10 minutes
const MAX_SKEW_MS = 2 * 60 * 1000;   // tolerated clock drift into the future

function send(res, code, obj, cache) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", cache || "no-store");
  res.end(JSON.stringify(obj));
}
async function loadRound() {
  const raw = await L.redis("GET", "bv:round");
  if (!raw) return null;
  const r = JSON.parse(raw);
  r.expired = !r.closed_at && !!r.closes_at && Date.now() >= Date.parse(r.closes_at);
  r.open = !!r.open && !r.closed_at && !r.expired;
  return r;
}
function publicRound(r) {
  return { number: r.number, title: r.title, options: r.options, open: r.open, opened_at: r.opened_at, closes_at: r.closes_at || null,
    closed_at: r.closed_at || null, final: !!r.finalized_at, min_tokens: r.min_ui || 0, weight_rule: "lower of balance when voting and balance at close" };
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async function handler(req, res) {
  if (!L.redisConf()) return send(res, 200, { configured: false });
  const mint = L.env("TOKEN_CA");
  try {
    let round = await loadRound();

    if (req.method === "GET") {
      if (!round) return send(res, 200, { configured: true, round: null }, "s-maxage=10, stale-while-revalidate=30");
      if ((round.expired || round.closed_at) && !round.finalized_at && L.B58.test(mint)) {
        try { round = await L.finalizeRound(round, mint); round.open = false; } catch (e) { /* retried on the next request */ }
      }
      const q = new URL(req.url, "http://x").searchParams;
      const votes = {};
      const h = L.hashToObj(await L.redis("HGETALL", "bv:votes:" + round.number));
      for (const k in h) votes[k] = JSON.parse(h[k]);
      const t = L.tally(round.options, votes, round.decimals);
      const out = { configured: true, round: publicRound(round), tally: t, updated_at: new Date().toISOString() };
      if (q.get("full")) out.votes = Object.values(votes).sort((a, b) => (a.at < b.at ? -1 : 1));
      return send(res, 200, out, "s-maxage=5, stale-while-revalidate=20");
    }

    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    if (!round || !round.open) return send(res, 409, { error: "No round is open right now." });

    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: "Bad request body." }); }
    const wallet = String(body.wallet || "");
    const message = String(body.message || "");
    const signature = String(body.signature || "");
    if (!L.B58.test(wallet)) return send(res, 400, { error: "Bad wallet address." });
    if (!message || message.length > 1000) return send(res, 400, { error: "Bad message." });
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature)) return send(res, 400, { error: "Bad signature." });

    const m = L.parseMessage(message);
    if (!/ vote$/.test(m.header)) return send(res, 400, { error: "This is not a ballot message." });
    if (m.round !== String(round.number)) return send(res, 400, { error: "This vote is for a different round. Reload the page." });
    if (!round.options.includes(m.choice)) return send(res, 400, { error: "That option is not on this round's ballot." });
    if (m.wallet !== wallet) return send(res, 400, { error: "The wallet in the message does not match." });
    if (!/^[0-9a-f]{8,64}$/.test(m.nonce || "")) return send(res, 400, { error: "Bad nonce." });
    const at = Date.parse(m.issuedAt || "");
    if (!at || Date.now() - at > MAX_AGE_MS || at - Date.now() > MAX_SKEW_MS) return send(res, 400, { error: "This signature is too old. Sign again." });

    let ok = false;
    try { ok = L.verifySig(wallet, message, signature); } catch (e) { ok = false; }
    if (!ok) return send(res, 401, { error: "The signature does not match this wallet." });

    let bal;
    try { bal = (await L.ownerBalance(wallet, mint)).raw; }
    catch (e) { return send(res, 503, { error: "Could not read your balance right now. Try again in a minute." }); }
    if (bal === 0n) return send(res, 403, { error: "This wallet holds no tokens, so it cannot vote." });
    if (round.min_raw && bal < BigInt(round.min_raw)) return send(res, 403, { error: "This wallet holds less than the " + round.min_ui + " token minimum." });

    const fresh = await L.redis("SET", "bv:nonce:" + m.nonce, wallet, "NX", "EX", 86400);
    if (fresh !== "OK") return send(res, 409, { error: "This signature was already used. Sign again." });

    const key = "bv:votes:" + round.number;
    const prev = await L.redis("HGET", key, wallet);
    if (prev && JSON.parse(prev).at > new Date(at).toISOString()) return send(res, 409, { error: "A newer vote from this wallet is already counted." });
    const vote = { wallet, choice: m.choice, balance: bal.toString(), message, signature, at: new Date(at).toISOString() };
    await L.redis("HSET", key, wallet, JSON.stringify(vote));

    return send(res, 200, { ok: true, replaced: !!prev, round: round.number, choice: m.choice, balance: Number(bal) / 10 ** round.decimals });
  } catch (e) {
    return send(res, 500, { error: "Server error: " + e.message });
  }
};