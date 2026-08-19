#!/usr/bin/env python3
"""Migrate API key records to explicit scopes (post-7a audit, /cso H1).

WHY THIS EXISTS
---------------
The 7a audit added scope gating to every endpoint. `api/main.py` requires
SCOPE_SCAN on /v1/verify (:504, :525), SCOPE_ENROLL on /v1/enroll (:542),
SCOPE_CLAIM on /v1/claim (:563) and SCOPE_RPC on /v1/rpc (:746).

Keys provisioned before scopes existed carry no `scopes` field and are treated
as LEGACY_SCOPES = (scan, enroll), which means they are REFUSED on /v1/claim
and /v1/rpc. Deploying the scope-gated API without migrating keys first breaks
whatever depends on those endpoints.

MEASURED ON THE VPS 2026-08-17: the live site's key (`ibw-website`) is used for
/api/v1/rpc — the ONLY endpoint website/js calls. It therefore needs
`rpc:proxy` explicitly, or safustaking.com breaks on deploy.

STANDALONE BY DESIGN
--------------------
Talks to Redis directly and duplicates the scope constants rather than
importing `api.cache`. This is a DATA migration that must run BEFORE the new
code deploys — at which point the new constants do not exist in the deployed
tree yet. Importing them would make the migration depend on the very deploy it
is supposed to precede. Keep the constants below in sync with api/cache.py.

SAFETY
------
- Dry run by default. Pass --apply to write.
- Idempotent: records that already have an explicit `scopes` list are left
  untouched, so re-running is safe.
- Writes a JSON backup of every record before modifying anything; --apply
  refuses to proceed if the backup cannot be written.
- Never widens access on its own. The default grant reproduces today's
  effective access exactly. Money/proxy scopes are granted ONLY to owners
  named via --grant-claim / --grant-rpc.

USAGE
-----
  python3 scripts/migrate_api_key_scopes.py                    # inspect only
  python3 scripts/migrate_api_key_scopes.py --apply \
      --grant-rpc ibw-website                                  # real migration

Run against the VPS Redis — local Redis holds only test fixtures.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import redis as redis_lib

HASH_NAME = "safu:apikeys"

SCOPE_SCAN = "scan:read"
SCOPE_ENROLL = "enroll:write"
SCOPE_CLAIM = "claim:write"
SCOPE_RPC = "rpc:proxy"

#: Matches api/cache.py's LEGACY_SCOPES — what a record with no `scopes`
#: field is treated as having today.
LEGACY_SCOPES = (SCOPE_SCAN, SCOPE_ENROLL)

#: A SHA-256 hex digest is 64 chars. Anything else in the field position is a
#: RAW, UNHASHED API key — directly usable by anyone who can read Redis, and
#: also dead, because validate_api_key() hashes the presented key before
#: looking it up and will therefore never match a plaintext field.
_SHA256_HEX_LEN = 64


def _is_plaintext_field(field: str) -> bool:
    if len(field) != _SHA256_HEX_LEN:
        return True
    try:
        int(field, 16)
    except ValueError:
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--grant-claim", action="append", default=[], metavar="OWNER",
                    help="owner to additionally grant claim:write (repeatable)")
    ap.add_argument("--grant-rpc", action="append", default=[], metavar="OWNER",
                    help="owner to additionally grant rpc:proxy (repeatable)")
    ap.add_argument("--backup-dir", default=".", help="where to write the pre-migration backup")
    ap.add_argument("--redis-url", default=os.environ.get("REDIS_URL", "redis://localhost:6379"))
    args = ap.parse_args()

    client = redis_lib.from_url(args.redis_url, decode_responses=True)
    try:
        client.ping()
    except Exception as e:
        print(f"ERROR: Redis unreachable at {args.redis_url}: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    records = client.hgetall(HASH_NAME)
    if not records:
        print(f"No records in {HASH_NAME}. Nothing to do.")
        return 0

    if args.apply:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = Path(args.backup_dir) / f"apikeys-backup-{stamp}.json"
        try:
            backup.write_text(json.dumps(records, indent=2))
            backup.chmod(0o600)
        except Exception as e:
            print(f"ERROR: refusing to apply, backup failed: {e}", file=sys.stderr)
            return 1
        print(f"Backup written: {backup}  ({len(records)} records, mode 600)")

    changed = skipped = 0
    plaintext = []

    for field, raw in records.items():
        try:
            data = json.loads(raw)
        except Exception as e:
            print(f"  !! UNPARSEABLE record field={field[:12]}... ({e}) — skipped, fix by hand")
            continue

        owner = data.get("owner")

        if _is_plaintext_field(field):
            # Reported, never auto-deleted: destroying credential records is
            # not this script's job, and the operator may want the value first.
            plaintext.append((field, owner))

        if data.get("scopes") is not None:
            print(f"  skip     owner={owner!r} already explicit: {data['scopes']}")
            skipped += 1
            continue

        scopes = list(LEGACY_SCOPES)
        if owner in args.grant_claim:
            scopes.append(SCOPE_CLAIM)
        if owner in args.grant_rpc:
            scopes.append(SCOPE_RPC)

        print(f"  migrate  owner={owner!r} -> {scopes}")
        changed += 1

        if args.apply:
            data["scopes"] = scopes
            data["scopes_migrated_at"] = int(time.time())
            client.hset(HASH_NAME, field, json.dumps(data))

    verb = "migrated" if args.apply else "would migrate"
    print(f"\n{verb}: {changed}   already explicit: {skipped}   total: {len(records)}")

    if plaintext:
        print("\n!! PLAINTEXT KEY RECORDS FOUND — the field is the raw API key, not a hash.")
        print("   Anyone with Redis read access holds a usable bearer token.")
        print("   These records are also DEAD: validate_api_key() hashes the presented")
        print("   key before lookup, so a plaintext field can never match a request.")
        for field, owner in plaintext:
            print(f"     field={field!r}  owner={owner!r}")
        print("   Recommended: delete them once you have confirmed nothing depends on them:")
        for field, _ in plaintext:
            print(f"     redis-cli hdel {HASH_NAME} {field}")

    if not args.apply:
        print("\nDRY RUN — no changes written. Re-run with --apply to commit.")
    else:
        remaining = sum(
            1 for raw in client.hgetall(HASH_NAME).values()
            if json.loads(raw).get("scopes") is None
        )
        print(f"records still lacking an explicit scopes field: {remaining}")
        if remaining == 0:
            print("All records explicit — cache.LEGACY_SCOPES can now be removed.")
        else:
            print("WARNING: some records are still implicit; do NOT remove LEGACY_SCOPES yet.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
