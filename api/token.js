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
const TTL = 120 * 1000;
const MAX_TX = 60; // most recent creator transactions scanned per refresh
let cache = { at: 0, body: null };

function env(k) { return (process.env[k] || "").trim(); }

async function rpc(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  return r.json();
}
async function call(url, method, params) {
  const j = await rpc(url, { jsonrpc: "2.0", id: 1, method, params });
  if (j.error) throw new Error(`${method}: ${j.error.message || "error"}`);
  return j.result;
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
    const list = await call(url, "getProgramAccounts", [program, { encoding: "base64", dataSlice: { offset: 32, length: 40 }, filters }]);
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
  for (let i = 0; i < ok.length; i += 20) {
    const chunk = ok.slice(i, i + 20);
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
  const [h, f, sp] = await Promise.allSettled([
    holders(url, mint),
    B58.test(creator) ? feeClaims(url, creator, mint, vaults) : Promise.resolve(null),
    call(url, "getTokenSupply", [mint]),
  ]);
  if (sp.status === "fulfilled" && sp.value && sp.value.value) out.supply = { amount: sp.value.value.uiAmountString, decimals: sp.value.value.decimals };
  else if (sp.status === "rejected") out.errors.push("supply: " + sp.reason.message);
  if (h.status === "fulfilled") out.holders = { count: h.value.count, as_of: out.updated_at, source: `https://solscan.io/token/${mint}#holders` };
  else out.errors.push("holders: " + h.reason.message);
  if (f.status === "fulfilled" && f.value) {
    const total = f.value.reduce((s, c) => s + c.amount, 0);
    out.fees = { total_sol: Math.round(total * 1e6) / 1e6, claims: f.value, method: vaults.size ? "vault" : "heuristic", scanned: MAX_TX };
  } else if (f.status === "rejected") out.errors.push("fees: " + f.reason.message);
  const body = JSON.stringify(out);
  if (!out.errors.length) cache = { at: Date.now(), body };
  res.setHeader("Cache-Control", out.errors.length ? "no-store" : "s-maxage=120, stale-while-revalidate=600");
  res.end(body);
};
module.exports._test = { claimAmount, holders, feeClaims, b58 };