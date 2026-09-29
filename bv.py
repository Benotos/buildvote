#!/usr/bin/env python3
"""Update live.json for the Live build page. No installs needed.

Examples
  python3 bv.py status building "Round 1: bundle detector, funding lookups"
  python3 bv.py status idle
  python3 bv.py session --task "Funding graph" --calls 300 --cost 8.15 --log https://github.com/you/repo/blob/main/logs/2.md
  python3 bv.py ledger --type claim --amount 2.5 --to "Fee wallet" --tx 5abc...
  python3 bv.py ledger --type payout --amount 0.2 --to "@name PR #3" --tx 3zzz...
  python3 bv.py holders 1234 --source https://solscan.io/token/YOUR_CA#holders
  python3 bv.py round 1 --status voting --title "Round 1"
  python3 bv.py queue set "Bundle detector" building
  python3 bv.py queue add "New idea"
  python3 bv.py show

Types for ledger: claim, api, buyback, payout, reserve
Queue statuses: proposed, queued, building, shipped
Every row you add should point at something anyone can check (a log, a tx).
"""
import argparse, json, os, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "live.json")

def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def load():
    with open(PATH, encoding="utf-8") as f:
        return json.load(f)

def save(d):
    d["updated_at"] = now()
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print("live.json updated", d["updated_at"])

def need_https(u, what):
    if u and not u.startswith("https://"):
        sys.exit(f"{what} must be an https link")

def main():
    p = argparse.ArgumentParser(description="Update live.json", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("status"); s.add_argument("state", choices=["building", "idle", "standby", "paused"]); s.add_argument("task", nargs="?", default="")

    s = sub.add_parser("session")
    s.add_argument("--task", required=True); s.add_argument("--calls", type=int); s.add_argument("--cost", type=float, required=True)
    s.add_argument("--log", required=True, help="https link to the session log"); s.add_argument("--date")

    s = sub.add_parser("ledger")
    s.add_argument("--type", required=True, choices=["claim", "api", "buyback", "payout", "reserve"])
    s.add_argument("--amount", type=float, required=True); s.add_argument("--unit", default="SOL")
    s.add_argument("--to", default=""); s.add_argument("--tx", required=True, help="Solana transaction signature"); s.add_argument("--date")

    s = sub.add_parser("holders"); s.add_argument("count", type=int); s.add_argument("--source", required=True)

    s = sub.add_parser("round"); s.add_argument("number", type=int); s.add_argument("--status", default=""); s.add_argument("--title", default="")

    s = sub.add_parser("queue"); s.add_argument("action", choices=["add", "set", "remove"]); s.add_argument("title"); s.add_argument("status", nargs="?", default="proposed")

    sub.add_parser("show")
    a = p.parse_args()
    d = load()

    if a.cmd == "show":
        print(json.dumps(d, indent=2)); return
    if a.cmd == "status":
        d["agent"] = {"status": a.state, "task": a.task}
    elif a.cmd == "session":
        need_https(a.log, "--log")
        d.setdefault("sessions", []).append({"date": a.date or now(), "task": a.task, "calls": a.calls, "cost_usd": round(a.cost, 4), "log_url": a.log})
    elif a.cmd == "ledger":
        d.setdefault("ledger", []).append({"date": a.date or now(), "type": a.type, "amount": a.amount, "unit": a.unit, "to": a.to, "tx": a.tx})
    elif a.cmd == "holders":
        need_https(a.source, "--source")
        d["holders"] = {"count": a.count, "as_of": now(), "source": a.source}
    elif a.cmd == "round":
        d["round"] = {"number": a.number, "status": a.status, "title": a.title}
    elif a.cmd == "queue":
        q = d.setdefault("queue", [])
        hit = [x for x in q if x.get("title", "").lower() == a.title.lower()]
        if a.action == "add":
            if hit: sys.exit("already in queue")
            q.append({"title": a.title, "status": a.status})
        elif a.action == "set":
            if not hit: sys.exit("not in queue")
            hit[0]["status"] = a.status
        else:
            d["queue"] = [x for x in q if x not in hit]
    save(d)

if __name__ == "__main__":
    main()