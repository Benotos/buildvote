// Vercel serverless function: real on-chain numbers for the Live build page.
// Works with ANY Solana RPC provider (Alchemy, QuickNode, Helius, Chainstack...).
// Settings (Vercel → Project → Settings → Environment Variables, or .env.local for `vercel dev`):
//   SOLANA_RPC_URL   full RPC URL from your provider, with the key in it. Never put it in the page.
//   TOKEN_CA         the token mint address
//   CREATOR_WALLET   the wallet that created the token and receives creator fees
//   FEE_VAULTS       optional, comma separated vault address(es) that claims come from, for exact matching

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUMP_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun bonding curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM
]);
const WSOL = "So11111111111111111111111111111111111111112";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TTL = 5 * 60 * 1000; // refresh at most every 5 minutes to stay inside free RPC limits
const MAX_TX = 60; // most recent creator transactions scanned per refresh
let cache = { at: 0, body: null };
const good = {}; // last good value per field, reused if a later refresh fails

function env(k) { return (process.env[k] || "").trim(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, body) {
  // Free RPC plans rate limit (429). Back off and retry instead of failing.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 && attempt < 4) { await sleep(800 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const j = await r.json();
    const limited = (x) => x && x.error && (x.error.code === 429 || /rate|limit|exceed/i.test(x.error.message || ""));
    if (attempt < 4 && (Array.isArray(j) ? j.some(limited) : limited(j))) { await sleep(800 * (attempt + 1)); continue; }
    return j;
  }
}
async function call(url, method, params) {
  const j = await rpc(url, { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${method}: ${j.error.message || "error"}`);
  return j.result;
}


// Paged version first (Alchemy's getProgramAccountsV2 works on free plans); plain getProgramAccounts as fallback.
async function programAccounts(callFn, program, cfg) {
  try {
    const all = [];
    let key = null;
    for (let page = 0; page < 200; page++) {
      const opts = Object.assign({}, cfg, { limit: 5000 });
      if (key) opts.paginationKey = key;
      const r = await callFn("getProgramAccountsV2", [program, opts]);
      const v = r && r.value ? r.value : r;
      if (!v || !Array.isArray(v.accounts)) throw new Error("no v2");
      all.push(...v.accounts);
      key = v.paginationKey;
      if (typeof key !== "string" || !key) return all;
    }
    return all;
  } catch (e) {
    if (!/not found|not supported|no v2|unknown|-32601/i.test(e.message)) throw e;
    return (await callFn("getProgramAccounts", [program, cfg])) || [];
  }
}

// ---------- holders ----------
function readU64LE(buf, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(buf[off + i]);
  return v;
}
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
async function holders(url, mint) {
  const owners = new Set();
  for (const program of [TOKEN_PROGRAM, TOKEN_2022]) {
    const filters = [{ memcmp: { offset: 0, bytes: mint } }];
    if (program === TOKEN_PROGRAM) filters.push({ dataSize: 165 });
    // owner (32 bytes at 32) + amount (8 bytes at 64)
    const list = await programAccounts((m, p) => call(url, m, p), program, { encoding: "base64", dataSlice: { offset: 32, length: 40 }, filters });
    for (const acc of list || []) {
      const raw = Buffer.from(acc.account.data[0], "base64");
      if (raw.length < 40) continue;
      if (readU64LE(raw, 32) > 0n) owners.add(b58(raw.subarray(0, 32)));
    }
  }
  return { count: owners.size };
}

// ---------- fee claims ----------
function keysOf(tx) {
  return (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
}
function programsOf(tx) {
  const ids = (tx.transaction.message.instructions || []).map((i) => i.programId);
  for (const inner of (tx.meta && tx.meta.innerInstructions) || []) for (const i of inner.instructions || []) ids.push(i.programId);
  return ids;
}
function tokenDelta(tx, owner, mint) {
  const sum = (arr) => (arr || []).filter((b) => b.owner === owner && b.mint === mint)
    .reduce((s, b) => s + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}
function claimAmount(tx, creator, mint, vaults) {
  if (!tx || !tx.meta || tx.meta.err) return 0;
  const keys = keysOf(tx);
  const ci = keys.indexOf(creator);
  if (ci < 0) return 0;
  if (!programsOf(tx).some((p) => PUMP_PROGRAMS.has(p))) return 0;
  if (Math.abs(tokenDelta(tx, creator, mint)) > 0) return 0; // a buy or sell of the token, not a claim
  if (vaults.size) {
    const vi = keys.findIndex((k) => vaults.has(k));
    if (vi < 0) return 0;
    const vaultOut = (tx.meta.preBalances[vi] - tx.meta.postBalances[vi]) / 1e9;
    const wsolOut = -keys.filter((k) => vaults.has(k)).reduce((s, k) => s + tokenDelta(tx, k, WSOL), 0);
    return Math.max(0, vaultOut) + Math.max(0, wsolOut);
  }
  if (ci !== 0) return 0; // creator must have signed and paid the fee
  const fee = tx.meta.fee || 0;
  const solIn = (tx.meta.postBalances[ci] - tx.meta.preBalances[ci] + fee) / 1e9;
  const wsolIn = tokenDelta(tx, creator, WSOL);
  return Math.max(0, solIn) + Math.max(0, wsolIn);
}
async function feeClaims(url, creator, mint, vaults) {
  const sigs = await call(url, "getSignaturesForAddress", [creator, { limit: MAX_TX }]);
  const ok = (sigs || []).filter((s) => !s.err);
  const claims = [];
  for (let i = 0; i < ok.length; i += 10) {
    const chunk = ok.slice(i, i + 10);
    const batch = chunk.map((s, j) => ({ jsonrpc: "2.0", id: j, method: "getTransaction",
      params: [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }));
    let res = await rpc(url, batch);
    if (!Array.isArray(res)) res = [res];
    for (const item of res) {
      const s = chunk[item.id];
      if (!s || !item.result) continue;
      const sol = claimAmount(item.result, creator, mint, vaults);
      if (sol > 0.000001) {
        claims.push({ date: new Date((item.result.blockTime || s.blockTime || 0) * 1000).toISOString(), type: "claim",
          amount: Math.round(sol * 1e6) / 1e6, unit: "SOL", to: "Creator wallet", tx: s.signature, source: "chain" });
      }
    }
  }
  return claims;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  const url = env("SOLANA_RPC_URL"), mint = env("TOKEN_CA"), creator = env("CREATOR_WALLET");
  const vaults = new Set(env("FEE_VAULTS").split(",").map((s) => s.trim()).filter((s) => B58.test(s)));
  if (!/^https:\/\//.test(url) || !B58.test(mint)) {
    return res.end(JSON.stringify({ configured: false }));
  }
  if (cache.body && Date.now() - cache.at < TTL) {
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.end(cache.body);
  }
  const out = { configured: true, ca: mint, updated_at: new Date().toISOString(), holders: null, fees: null, supply: null, errors: [] };
  // One at a time, so a free RPC plan is not hit with everything at once.
  try {
    const sp = await call(url, "getTokenSupply", [mint]);
    good.supply = { amount: sp.value.uiAmountString, decimals: sp.value.decimals };
  } catch (e) { out.errors.push("supply: " + e.message); }
  // Holder counts need a heavy RPC call that many free plans block. Try it, and if it fails wait 30 minutes before trying again.
  if (!good.holdersFailAt || Date.now() - good.holdersFailAt > 30 * 60 * 1000) {
    try {
      const h = await holders(url, mint);
      good.holders = { count: h.count, as_of: out.updated_at, source: `https://solscan.io/token/${mint}#holders` };
      good.holdersFailAt = 0;
    } catch (e) { good.holdersFailAt = Date.now(); out.notes = ["holders: not available on this RPC plan (" + e.message + ")"]; }
  }
  if (B58.test(creator)) {
    try {
      const f = await feeClaims(url, creator, mint, vaults);
      const total = f.reduce((s, c) => s + c.amount, 0);
      good.fees = { total_sol: Math.round(total * 1e6) / 1e6, claims: f, method: vaults.size ? "vault" : "heuristic", scanned: MAX_TX };
    } catch (e) { out.errors.push("fees: " + e.message); }
  }
  out.supply = good.supply || null;
  out.holders = good.holders || null;
  out.fees = good.fees || null;
  const body = JSON.stringify(out);
  cache = { at: out.errors.length ? Date.now() - TTL / 2 : Date.now(), body };
  // Shared CDN cache: every visitor reads the same copy, so the RPC is called about once a minute, not once per visitor.
  res.setHeader("Cache-Control", out.errors.length ? "s-maxage=120, stale-while-revalidate=600" : "s-maxage=300, stale-while-revalidate=900");
  res.end(body);
};
module.exports._test = { claimAmount, holders, feeClaims, b58 };