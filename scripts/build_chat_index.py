#!/usr/bin/env python3
"""
Builds a full map of every WhatsApp chat (1:1 and group) with resolved
human names, so a future lookup never has to re-discover the same
nickname/@lid gotchas documented in memory/reference_whatsapp_mcp_connected.md.

Run after `/refresh-contacts` or whenever lookups start going stale:
    python3 scripts/build_chat_index.py

Outputs:
    data/chat_index.json   - machine-readable, full detail
    CHAT_INDEX.md           - human/LLM-readable, grep-friendly
"""
import sqlite3
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "whatsapp.db"

def normalize(name):
    if not name:
        return ""
    name = re.sub(r'[\U0001F300-\U0001FAFF☀-➿‍‎️]', '', name)
    return re.sub(r'\s+', ' ', name).strip().lower()

def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    contacts = {r["jid"]: dict(r) for r in con.execute("SELECT jid, name, notify, phone_number FROM contacts")}
    chats = {r["jid"]: dict(r) for r in con.execute("SELECT jid, name, last_message_time FROM chats")}

    # last activity + message count per chat, from messages table (ground truth,
    # chats.last_message_time can lag)
    activity = {}
    for r in con.execute("SELECT chat_jid, MAX(timestamp) as last_ts, COUNT(*) as n FROM messages GROUP BY chat_jid"):
        activity[r["chat_jid"]] = {"last_active": r["last_ts"], "message_count": r["n"]}

    def resolve_name(jid):
        c = contacts.get(jid)
        if c:
            if c.get("name"):
                return c["name"]
            if c.get("notify"):
                return c["notify"]
        ch = chats.get(jid)
        if ch and ch.get("name"):
            return ch["name"]
        return None

    one_to_one = []
    groups = []

    for jid, ch in chats.items():
        act = activity.get(jid, {"last_active": None, "message_count": 0})
        if jid.endswith("@g.us"):
            # resolve participants from distinct senders seen in this group's messages
            rows = con.execute(
                "SELECT DISTINCT sender FROM messages WHERE chat_jid=? AND sender IS NOT NULL AND sender != ''",
                (jid,)
            ).fetchall()
            members = []
            for r in rows:
                s = r["sender"]
                members.append({"jid": s, "name": resolve_name(s) or s})
            groups.append({
                "jid": jid,
                "name": ch.get("name") or "(unnamed group)",
                "last_active": act["last_active"],
                "message_count": act["message_count"],
                "members": sorted(members, key=lambda m: m["name"]),
            })
        else:
            one_to_one.append({
                "jid": jid,
                "name": resolve_name(jid) or "(unresolved)",
                "jid_type": "lid" if jid.endswith("@lid") else "phone",
                "last_active": act["last_active"],
                "message_count": act["message_count"],
            })

    # collapse people with multiple JIDs (the documented gotcha) under one
    # canonical name, marking which JID is actually live
    by_name = defaultdict(list)
    for p in one_to_one:
        key = normalize(p["name"]) if p["name"] != "(unresolved)" else None
        if key:
            by_name[key].append(p)

    duplicates = {}
    for name_key, entries in by_name.items():
        if len(entries) > 1:
            entries_sorted = sorted(entries, key=lambda e: e["last_active"] or "", reverse=True)
            duplicates[entries_sorted[0]["name"]] = {
                "live_jid": entries_sorted[0]["jid"],
                "live_last_active": entries_sorted[0]["last_active"],
                "stale_jids": [{"jid": e["jid"], "last_active": e["last_active"]} for e in entries_sorted[1:]],
            }

    out = {
        "generated_from": str(DB),
        "one_to_one_count": len(one_to_one),
        "group_count": len(groups),
        "duplicate_people_count": len(duplicates),
        "one_to_one": sorted(one_to_one, key=lambda p: (p["last_active"] or ""), reverse=True),
        "groups": sorted(groups, key=lambda g: (g["last_active"] or ""), reverse=True),
        "duplicates": duplicates,
    }

    (ROOT / "data" / "chat_index.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))

    # human-readable markdown
    lines = ["# WhatsApp chat index", "",
             f"Generated from `{DB.name}`. {len(one_to_one)} 1:1 chats, {len(groups)} groups, "
             f"{len(duplicates)} people with more than one JID.", "",
             "Regenerate: `python3 scripts/build_chat_index.py`", "",
             "## People with multiple JIDs (use the live one, not the stale one)", ""]
    for name, d in sorted(duplicates.items()):
        lines.append(f"- **{name}** — live: `{d['live_jid']}` (last active {d['live_last_active']}); "
                      f"stale: {', '.join(s['jid'] for s in d['stale_jids'])}")
    lines += ["", "## Groups (by last activity)", ""]
    for g in sorted(groups, key=lambda g: (g["last_active"] or ""), reverse=True):
        if not g["last_active"]:
            continue
        member_names = ", ".join(m["name"] for m in g["members"] if m["name"] and not m["name"].endswith("@lid") and "@" not in m["name"])
        lines.append(f"- **{g['name']}** (`{g['jid']}`) — last active {g['last_active']}, {g['message_count']} msgs"
                      + (f" — members: {member_names}" if member_names else ""))
    lines += ["", "## 1:1 chats (by last activity, top 150)", ""]
    for p in [p for p in out["one_to_one"] if p["last_active"]][:150]:
        lines.append(f"- **{p['name']}** (`{p['jid']}`) — last active {p['last_active']}, {p['message_count']} msgs")

    (ROOT / "CHAT_INDEX.md").write_text("\n".join(lines))
    print(f"Wrote data/chat_index.json ({len(one_to_one)} 1:1, {len(groups)} groups, {len(duplicates)} duplicate people)")
    print(f"Wrote CHAT_INDEX.md")

if __name__ == "__main__":
    main()
