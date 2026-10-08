# Desk manual database

Postgres database that replaces the desk manual spreadsheet. Design decisions: see the
"Desk Manual Database Decisions" page. Summary is at the top of `schema.sql`.

## How it's organised

| Schema | What it holds | Who writes it |
|---|---|---|
| `public` | campuses, users, change requests, change log, releases | editor app |
| `staging` | the **next version** of the manual | approved change requests |
| `live` | the **published** version the assistant reads | only `publish()` / `rollback_to()` |

An edit's path: editor proposes (`change_request`) → approver accepts → applied to `staging`
→ `release_checks()` → approver runs `publish()` → new release, `live` replaced.
`rollback_to(user, version)` makes an older release live again without touching `staging`.

Rows are never deleted from `staging`. Retire them with `active = false`.

## Set up a fresh database

```powershell
psql -d deskmanual -f db/schema.sql
psql -d deskmanual -c "INSERT INTO app_user VALUES ('<your asurite>', '<your name>', 'admin')"
pip install "psycopg[binary]"
python db/import_core.py --dsn "postgresql://<user>:<pass>@localhost:5432/deskmanual" --publish-as <your asurite>
```

The importer reads `buildings_lookup.json` and `firstCallExamples_enriched.json` (made by the
scripts in `tools/`), prints check results, and lists anything it couldn't decide as QUESTIONS.

## Useful queries

```sql
-- where does a task go? (what the assistant will read)
SELECT * FROM live.routing_lookup WHERE description = 'Plumbing - GENERAL';

-- which zones cover a building?
SELECT * FROM live.building_lookup WHERE code = '157A';

-- what would block a publish right now?
SELECT * FROM release_checks();

-- release history
SELECT version, published_at, published_by, note, is_live FROM release ORDER BY version DESC;
```
