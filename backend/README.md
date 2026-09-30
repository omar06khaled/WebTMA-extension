# WebTMA Assistant backend (FastAPI)

Python port of `server.js`. Same endpoints and response shapes, so the extension needs no changes.
Runtime model: OpenAI `gpt-4o-mini` (change with `OPENAI_MODEL`).

## Run locally (Windows PowerShell, from the repo root)

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
cd backend
uvicorn main:app --reload --port 3000
```

`.env` in the repo root needs:

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | yes | server refuses to start without it |
| `OPENAI_MODEL` | no | defaults to `gpt-4o-mini` |
| `LAYER2_ENABLED` | no | `true` turns on the desk manual fallback |
| `LAYER2_URL` | if Layer 2 on | 2027 manual: `https://absylmqaiibsjemqecyy.supabase.co/functions/v1/layer2-2027` |
| `SUPABASE_ANON_KEY` | if Layer 2 on | unchanged |
| `AUDIT_LOG_PATH` | no | defaults to `audit.log` in the repo root |

`ANTHROPIC_API_KEY` is no longer used.

## Test

```powershell
pip install pytest
python -m pytest backend/tests -q        # offline, model and Supabase are faked
python backend/eval_model.py             # real model calls on backend/eval_cases.json
```

The eval costs a few cents per full run (each Layer 1 call sends the whole knowledge base).

## Rebuilding from a new desk manual

```powershell
pip install openpyxl
python tools/build_knowledge_base.py "Desk Manual 2027.xlsx"   # -> firstCallExamples_enriched.json
python tools/build_chunks.py "Desk Manual 2027.xlsx"           # -> chunks.jsonl (phones/emails redacted)
python tools/build_buildings.py "Desk Manual 2027.xlsx"        # -> buildings_lookup.json zones from the zone guides
node --env-file=.env load_chunks.mjs chunks.jsonl              # embeds into desk_manual_chunks_2027
```

`build_knowledge_base.py` prints anything it couldn't map cleanly. Read that list before shipping.
When a manual renames zones, update `ZONE_OPTIONS` in `build_knowledge_base.py` and the zone headers in `build_buildings.py` (`GUIDES`).

## Render

- Runtime: Python 3
- Build command: `pip install -r backend/requirements.txt`
- Start command: `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT`
- Environment: the variables above

`audit.log` lives on Render's disk, which is wiped on every deploy (same as the Node version).
