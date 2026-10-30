# Docs

Diagrams and working notes for the WebTMA assistant. Nothing here contains keys, tokens or staff contact details.

## Architecture diagrams

| File | What it shows |
|---|---|
| `architecture/01-architecture-today.png` | What runs today on `main`: Chrome extension, local FastAPI backend (Layer 1 and Layer 2), Create AI and Supabase |
| `architecture/02-architecture-planned-database.png` | The planned desk manual database and web app. Not built or connected yet |
| `architecture/03-erd-manual-tables.png` | Relational diagram of the manual data tables (zones, buildings, tasks, routing rules, articles, contacts) |
| `architecture/04-erd-workflow-tables.png` | Relational diagram of the workflow tables (users, change requests, releases, flags) |
| `architecture/05-erd-full.png` | One relational diagram with all 26 tables and their foreign keys (solid lines), plus the loose links by name or id (dotted). Purple is manual data, green is workflow. Very wide (about 4,450 px at 1x), so zoom in. Source is `src/05-erd-full.html` |
| `architecture/05-full-database.png` | The whole database in one picture: the `staging`, `live` and `public` schemas, every table, who reads and writes what, and the rules the database enforces. Source is `05-full-database.svg` |

The ERDs are drawn from `db/schema.sql` on this branch. They show key columns only. The schema itself was not run against a real database when the diagrams were made, so treat `db/schema.sql` as the source of truth.

Sources are in `architecture/` (`.svg`) and `architecture/src/` (`.html`, which load mermaid from a CDN). To regenerate a PNG with headless Chrome:

```
chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=680,470 --screenshot=out.png file:///path/to/01-architecture-today.svg
```

## Design mockups

`../design/` holds the source files of the "WebTMA Assistant Mockups" Claude Design canvas (UI round 3: home, sign-in, dispatch, desk manual, lookups, editor, entry, admin, Excel import check). They are Claude Design files and may not render outside Claude Design.

## Work log

- Set up the local dev environment: Python 3.14, a `.venv` at the repo root, `backend/requirements.txt` installed.
- Configured the backend for ASU Create AI through a root-level `.env` (git-ignored). Variable names: `OPENAI_API_KEY`, `OPENAI_BASE_URL` (the `api-main` endpoint, which must match the token's environment), `OPENAI_MODEL` (`openai/gpt6_luna`), and for Layer 2 `LAYER2_ENABLED`, `LAYER2_URL`, `SUPABASE_ANON_KEY`.
- Ran the backend from VS Code Run and Debug ("WebTMA backend (local)", port 3000) and loaded the extension unpacked in Chrome. Suggestions work end to end.
- Reviewed this branch. The database schema is solid but nothing uses it yet. Open items:
  - Contacts are not imported (the contact sheets come in as articles).
  - `db/setup.py` cannot be re-run after a partial failure.
  - The 51 checks in `db/test_rules.py` have not been run.
  - Nothing connects the database to the backend.
- This branch is behind `main` by 6 commits, including the Create AI base URL support. A read-only check showed `main` would merge in without conflicts. Merge `main` before running the backend from this branch.
