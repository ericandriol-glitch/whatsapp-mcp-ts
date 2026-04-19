"""Decrypt iPhone backup and extract WhatsApp ChatStorage.sqlite + Contacts.sqlite.

Password is read from macOS Keychain entry "ios-backup-password".
"""
import subprocess
import sys
from pathlib import Path

from iphone_backup_decrypt import EncryptedBackup, RelativePath

BACKUP_DIR = Path.home() / "Library/Application Support/MobileSync/Backup/00008140-000A18810A47001C"
OUT_DIR = Path.home() / "dev/life-jarvis/whatsapp-bridge/data/ios-import"


def get_password() -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "ios-backup-password", "-w"],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pwd = get_password()
    print(f"Opening backup: {BACKUP_DIR}", flush=True)
    backup = EncryptedBackup(backup_directory=str(BACKUP_DIR), passphrase=pwd)
    print("Testing decryption...", flush=True)
    backup.test_decryption()
    print("OK. Locating WhatsApp files via Manifest.db...", flush=True)

    # Find all WhatsApp files so we can see what's available
    with backup.manifest_db_cursor() as cur:
        cur.execute(
            "SELECT fileID, domain, relativePath FROM Files "
            "WHERE domain LIKE '%whatsapp%' "
            "ORDER BY domain, relativePath"
        )
        rows = cur.fetchall()
    print(f"Found {len(rows)} WhatsApp-related files. Samples:", flush=True)
    for r in rows[:15]:
        print(f"  [{r[1]}] {r[2]}", flush=True)

    # Locate ChatStorage + Contacts
    targets = {}
    for file_id, domain, rel in rows:
        name = Path(rel).name
        if name == "ChatStorage.sqlite":
            targets.setdefault("ChatStorage", (domain, rel))
        elif name == "ContactsV2.sqlite":
            targets.setdefault("Contacts", (domain, rel))

    if "ChatStorage" not in targets:
        print("ERROR: ChatStorage.sqlite not found in backup", file=sys.stderr)
        return 1

    for label, (domain, rel) in targets.items():
        out_path = OUT_DIR / Path(rel).name
        print(f"\nExtracting {label}: {domain} / {rel}  →  {out_path}", flush=True)
        backup.extract_file(domain_like=domain, relative_path=rel, output_filename=str(out_path))
        print(f"  wrote {out_path.stat().st_size:,} bytes", flush=True)

    # Also dump anything named Wal/Shm alongside ChatStorage (SQLite side files)
    cs_domain, cs_rel = targets["ChatStorage"]
    cs_parent = str(Path(cs_rel).parent)
    for file_id, domain, rel in rows:
        if domain == cs_domain and Path(rel).parent.as_posix() == cs_parent:
            name = Path(rel).name
            if name.startswith("ChatStorage.sqlite-"):
                out_path = OUT_DIR / name
                print(f"Extracting side file: {name}", flush=True)
                backup.extract_file(domain_like=domain, relative_path=rel, output_filename=str(out_path))

    return 0


if __name__ == "__main__":
    sys.exit(main())
