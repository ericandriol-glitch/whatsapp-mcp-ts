"""Import historical WhatsApp messages from a decrypted iOS ChatStorage.sqlite
into the Baileys bridge whatsapp.db.

Dedupe strategy:
  - A wamid (ZSTANZAID) already present in bridge.messages.id is preserved
    as-is (the bridge may have captured it under a different chat_jid
    format, e.g. @lid instead of @s.whatsapp.net — we don't want to
    introduce a second row for the same message).
  - New wamids are inserted with the iOS chat_jid.

Message-type mapping mirrors what the Baileys bridge writes for non-text
messages (e.g. '[Audio]', '[Image]').
"""
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

IOS_DB = Path.home() / "dev/life-jarvis/whatsapp-bridge/data/ios-import/ChatStorage.sqlite"
BRIDGE_DB = Path.home() / "dev/life-jarvis/whatsapp-bridge/data/whatsapp.db"

# Core Data reference date: 2001-01-01 00:00:00 UTC → Unix 978307200
CORE_DATA_EPOCH = 978307200

TYPE_PLACEHOLDER = {
    1: "[Image]",
    2: "[Video]",
    3: "[Audio]",
    4: "[Contact]",
    5: "[Location]",
    7: "[Sticker]",
    8: "[GIF]",
    11: "[This message was deleted]",
}
SKIP_TYPES = {6, 10, 14, 15, 59, 66}  # system/group-events, calls, polls, etc.


def core_data_to_iso(ts: float) -> str:
    if ts is None:
        return None
    dt = datetime.fromtimestamp(ts + CORE_DATA_EPOCH, tz=timezone.utc)
    # Match bridge format: 2026-04-18T14:09:31.000Z
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def synthesize_content(mtype: int, text: str | None) -> str | None:
    if text and text.strip():
        if mtype in TYPE_PLACEHOLDER and mtype != 0:
            return f"{TYPE_PLACEHOLDER[mtype]} {text.strip()}"
        return text.strip()
    if mtype == 0:
        return None  # empty text message — skip
    return TYPE_PLACEHOLDER.get(mtype)


def main() -> int:
    if not IOS_DB.exists():
        print(f"Missing {IOS_DB}", file=sys.stderr)
        return 1
    if not BRIDGE_DB.exists():
        print(f"Missing {BRIDGE_DB}", file=sys.stderr)
        return 1

    ios = sqlite3.connect(f"file:{IOS_DB}?mode=ro", uri=True)
    ios.row_factory = sqlite3.Row
    bridge = sqlite3.connect(str(BRIDGE_DB))
    bridge.execute("PRAGMA journal_mode=WAL")
    bridge.execute("PRAGMA synchronous=NORMAL")

    print("Loading existing wamids from bridge...", flush=True)
    existing = {row[0] for row in bridge.execute("SELECT id FROM messages")}
    print(f"  bridge already has {len(existing):,} messages", flush=True)

    print("\nLoading chat session lookup from iOS...", flush=True)
    chat_by_pk: dict[int, dict] = {}
    for row in ios.execute(
        "SELECT Z_PK, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE, ZLASTMESSAGEDATE FROM ZWACHATSESSION"
    ):
        chat_by_pk[row["Z_PK"]] = {
            "jid": row["ZCONTACTJID"],
            "name": row["ZPARTNERNAME"],
            "session_type": row["ZSESSIONTYPE"],
            "last_date": row["ZLASTMESSAGEDATE"],
        }
    print(f"  {len(chat_by_pk):,} chat sessions", flush=True)

    print("Loading group-member lookup from iOS...", flush=True)
    member_by_pk: dict[int, str] = {}
    for row in ios.execute("SELECT Z_PK, ZMEMBERJID FROM ZWAGROUPMEMBER"):
        if row["ZMEMBERJID"]:
            member_by_pk[row["Z_PK"]] = row["ZMEMBERJID"]
    print(f"  {len(member_by_pk):,} group members", flush=True)

    # ---- Chats ----
    print("\nUpserting chats...", flush=True)
    chat_rows = []
    for pk, chat in chat_by_pk.items():
        jid = chat["jid"]
        if not jid or jid == "0@status" or jid.endswith("@broadcast"):
            continue
        name = chat["name"]
        last = core_data_to_iso(chat["last_date"]) if chat["last_date"] else None
        chat_rows.append((jid, name, last))

    bridge.execute("BEGIN IMMEDIATE")
    inserted_chats = 0
    updated_chats = 0
    for jid, name, last in chat_rows:
        cur = bridge.execute("SELECT name, last_message_time FROM chats WHERE jid = ?", (jid,))
        existing_row = cur.fetchone()
        if existing_row is None:
            bridge.execute(
                "INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)",
                (jid, name, last),
            )
            inserted_chats += 1
        else:
            # Only fill in gaps — don't overwrite newer bridge data
            cur_name, cur_last = existing_row
            new_name = cur_name or name
            new_last = cur_last if (cur_last and (not last or cur_last > last)) else (last or cur_last)
            if new_name != cur_name or new_last != cur_last:
                bridge.execute(
                    "UPDATE chats SET name = ?, last_message_time = ? WHERE jid = ?",
                    (new_name, new_last, jid),
                )
                updated_chats += 1
    bridge.commit()
    print(f"  inserted {inserted_chats:,} new chats, updated {updated_chats:,}", flush=True)

    # ---- Messages ----
    print("\nStreaming messages from iOS...", flush=True)
    query = """
        SELECT m.ZSTANZAID AS wamid,
               m.ZTEXT AS text,
               m.ZISFROMME AS is_from_me,
               m.ZMESSAGETYPE AS mtype,
               m.ZMESSAGEDATE AS ts,
               m.ZCHATSESSION AS chat_pk,
               m.ZGROUPMEMBER AS member_pk,
               m.ZFROMJID AS from_jid
        FROM ZWAMESSAGE m
        WHERE m.ZSTANZAID IS NOT NULL
    """
    batch = []
    BATCH_SIZE = 5000
    inserted = 0
    skipped_dup = 0
    skipped_type = 0
    skipped_nochat = 0
    skipped_empty = 0
    skipped_status = 0

    bridge.execute("BEGIN IMMEDIATE")
    for row in ios.execute(query):
        wamid = row["wamid"]
        if wamid in existing:
            skipped_dup += 1
            continue

        mtype = row["mtype"] or 0
        if mtype in SKIP_TYPES:
            skipped_type += 1
            continue

        content = synthesize_content(mtype, row["text"])
        if content is None:
            skipped_empty += 1
            continue

        chat = chat_by_pk.get(row["chat_pk"])
        if not chat or not chat["jid"]:
            skipped_nochat += 1
            continue
        chat_jid = chat["jid"]
        if chat_jid == "0@status" or chat_jid.endswith("@broadcast"):
            skipped_status += 1
            continue

        is_from_me = 1 if row["is_from_me"] else 0
        # sender semantics matching bridge conventions
        if is_from_me:
            sender = ""
        elif chat_jid.endswith("@g.us"):
            sender = member_by_pk.get(row["member_pk"]) or row["from_jid"] or ""
        else:
            # 1:1 chat: sender is the other party (same as chat_jid)
            sender = row["from_jid"] or chat_jid

        ts_iso = core_data_to_iso(row["ts"])
        if ts_iso is None:
            skipped_empty += 1
            continue

        batch.append((wamid, chat_jid, sender, content, ts_iso, is_from_me))
        existing.add(wamid)  # guard against dupes inside this run

        if len(batch) >= BATCH_SIZE:
            bridge.executemany(
                "INSERT OR IGNORE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                batch,
            )
            inserted += bridge.total_changes  # not per-batch, we'll count at end
            bridge.commit()
            bridge.execute("BEGIN IMMEDIATE")
            if len(existing) % 50000 < BATCH_SIZE:
                print(f"  processed {len(existing):,} wamids, batch flushed", flush=True)
            batch.clear()

    if batch:
        bridge.executemany(
            "INSERT OR IGNORE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            batch,
        )
    bridge.commit()

    # Recount precisely
    total_now = bridge.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    print("\n=== Import summary ===")
    print(f"  bridge messages now: {total_now:,}")
    print(f"  skipped duplicates:  {skipped_dup:,}")
    print(f"  skipped type:        {skipped_type:,}")
    print(f"  skipped empty:       {skipped_empty:,}")
    print(f"  skipped no-chat:     {skipped_nochat:,}")
    print(f"  skipped status/bcst: {skipped_status:,}")

    ios.close()
    bridge.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
