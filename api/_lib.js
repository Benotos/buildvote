// Shared helpers for the voting functions. Files starting with "_" are not public routes on Vercel.
// Storage: Upstash Redis (free). Add it in Vercel → Storage → Upstash for Redis, and Vercel sets
// KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) for you.
const crypto = require("crypto");

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const CAP_PCT = 5; // no wallet counts for more than 5% of a round's total vote weight

function env(k) { return (process.env[k] || "").trim(); }

// ---------- base58 ----------
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = ALPH.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === "1") out.unshift(0); else break; }
  return Buffer.from(out);
}

// ---------- ed25519 signature check (Solana signMessage) ----------
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function verifySig(wallet, message, signatureB58) {
  const pk = b58decode(wallet);
  const sig = b58decode(signatureB58);
  if (pk.length !== 32 || sig.length !== 64) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message, "utf8"), key, sig);
}

// ---------- Redis (Upstash REST) ----------
function redisConf() {
  const url = env("KV_REST_API_URL") || env("UPSTASH_REDIS_REST_URL");
  const token = env("KV_REST_API_TOKEN") || env("UPSTASH_REDIS_REST_TOKEN");
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function redis(...cmd) {
  const c = redisConf();
  if (!c) throw new Error("storage not configured");
  const r = await fetch(c.url, { method: "POST", headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("redis: " + (j.error || r.status));
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const c = redisConf();
  const r = await fetch(c.url + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error("redis pipeline " + r.status);
  const bad = j.find((x) => x && x.error);
  if (bad) throw new Error("redis: " + bad.error);
  return j.map((x) => x.result);
}
function hashToObj(arr) {
  const o = {};
  for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

// ---------- Solana RPC ----------
async function call(method, params) {
  const url = env("SOLANA_RPC_URL");
  if (!/^https:\/\//.test(url)) throw new Error("SOLANA_RPC_URL not set");
  let j;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429 && attempt < 5) { await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error("rpc " + r.status);
    j = await r.json();
    if (j.error && attempt < 5 && (j.error.code === 429 || /rate|limit|exceed/i.test(j.error.message || ""))) { await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1))); continue; }
    break;
  }
  if (j.error) throw new Error(method + ": " + (j.error.message || "error"));
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
function readU64LE(buf, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(buf[off + i]);
  return v;
}
// Every wallet holding the token right now: { owner: rawAmount (string) }
async function snapshotHolders(mint) {
  const slot = await call("getSlot", [{ commitment: "confirmed" }]);
  const supply = await call("getTokenSupply", [mint]);
  const bal = new Map();
  for (const program of [TOKEN_PROGRAM, TOKEN_2022]) {
    const filters = [{ memcmp: { offset: 0, bytes: mint } }];
    if (program === TOKEN_PROGRAM) filters.push({ dataSize: 165 });
    const list = await programAccounts(call, program, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 32, length: 40 }, filters });
    for (const acc of list || []) {
      const raw = Buffer.from(acc.account.data[0], "base64");
      if (raw.length < 40) continue;
      const amt = readU64LE(raw, 32);
      if (amt === 0n) continue;
      const owner = b58encode(raw.subarray(0, 32));
      bal.set(owner, (bal.get(owner) || 0n) + amt);
    }
  }
  return { slot, decimals: supply.value.decimals, balances: bal };
}

// ---------- ballot message ----------
// Must match the text the site asks wallets to sign, line for line.
function parseMessage(text) {
  const lines = String(text).split("\n");
  const get = (label) => {
    const l = lines.find((x) => x.startsWith(label + ": "));
    return l ? l.slice(label.length + 2).trim() : null;
  };
  return {
    header: lines[0] || "",
    round: get("Round"),
    choice: get("Choice"),
    wallet: get("Wallet"),
    nonce: get("Nonce"),
    issuedAt: get("Issued at"),
  };
}

// ---------- tally ----------
// Weight = balance at the snapshot. No wallet may hold more than CAP_PCT% of the round's total counted weight.
// The heaviest wallets are trimmed to one common cap c, the largest value where c <= share * (sum of all trimmed weights).
// With fewer than 100/CAP_PCT voters a 5% share is impossible, so the max share becomes 1 / number of voters.
function capValue(ws, share) {
  const w = ws.slice().sort((x, y) => y - x);
  const total = w.reduce((s, x) => s + x, 0);
  if (!w.length || w[0] <= share * total) return Infinity;
  let rest = total;
  for (let k = 1; k <= w.length; k++) {
    rest -= w[k - 1];
    const den = 1 - k * share;
    if (den <= 0) return w[w.length - 1];
    const c = (share * rest) / den;
    const next = k < w.length ? w[k] : 0;
    if (c >= next && c <= w[k - 1]) return c;
  }
  return w[w.length - 1];
}
function tally(options, votes, decimals) {
  const list = Object.values(votes);
  const scale = 10 ** (decimals || 0);
  const share = list.length ? Math.max(CAP_PCT / 100, 1 / list.length) : CAP_PCT / 100;
  const cap = capValue(list.map((v) => Number(v.balance) / scale), share);
  const per = {};
  for (const o of options) per[o] = { choice: o, votes: 0, weight: 0 };
  for (const v of list) {
    const w = Math.min(Number(v.balance) / scale, cap);
    v.weight = w;
    if (!per[v.choice]) continue;
    per[v.choice].votes += 1;
    per[v.choice].weight += w;
  }
  const sum = Object.values(per).reduce((s, x) => s + x.weight, 0);
  const rows = options.map((o) => ({
    choice: o,
    votes: per[o].votes,
    weight: Math.round(per[o].weight * 100) / 100,
    pct: sum > 0 ? Math.round((per[o].weight / sum) * 10000) / 100 : 0,
  }));
  return { rows, voters: list.length, cap_pct: CAP_PCT, max_share_pct: Math.round(share * 10000) / 100, cap_tokens: cap === Infinity ? null : Math.round(cap * 100) / 100 };
}

module.exports = { env, B58, CAP_PCT, b58encode, b58decode, verifySig, redis, pipeline, redisConf, hashToObj, call, snapshotHolders, parseMessage, tally, capValue };