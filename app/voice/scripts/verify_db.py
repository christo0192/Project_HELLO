"""
Verify the screening_v2 schema is created AND exposed over the REST API.
Uses only httpx (no heavy deps). Run: python scripts/verify_db.py
"""

import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SCHEMA = os.getenv("SUPABASE_SCHEMA", "screening_v2")

TABLES = [
    "roles", "resumes", "candidates", "call_sessions", "transcript_turns",
    "assessments", "consent_records", "call_queue", "sms_follow_ups", "ats_sync_log",
]

headers = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Accept-Profile": SCHEMA,  # PostgREST: read from this schema
}

print(f"Checking schema '{SCHEMA}' in {URL}\n")
ok, bad = 0, 0
with httpx.Client(timeout=20) as c:
    for t in TABLES:
        r = c.get(f"{URL}/rest/v1/{t}", params={"select": "id", "limit": 1}, headers=headers)
        if r.status_code == 200:
            print(f"  OK    {t}")
            ok += 1
        else:
            detail = r.text[:120].replace("\n", " ")
            print(f"  FAIL  {t}  [{r.status_code}] {detail}")
            bad += 1

print(f"\n{ok}/{len(TABLES)} tables reachable.")
if bad:
    print("PGRST106/schema -> add screening_v2 to Settings>API>Exposed schemas.")
    print("42501/permission denied -> run the GRANT block from 0001_init.sql.")
    sys.exit(1)
print("screening_v2 is created and exposed. Persistence is ready.")
