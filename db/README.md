# Desk manual database

Postgres database that replaces the desk manual spreadsheet. It follows the
"Desk Assistant — User Stories" doc. The decisions are summarised at the top of `schema.sql`.

## How it's organised

| Schema | What it holds | Who writes it |
|---|---|---|
| `public` | users, change requests, releases, logs, flags, same-day changes, import review | the functions in `schema.sql` |
| `staging` | the **next version** of the manual | approved change requests |
| `live` | the **published** version the assistant and dispatchers read | only a confirmed release |

How an edit travels:

1. An editor calls `submit_change()`. `conflicts_for()` warns if someone else has a pending edit on the same entry, but doesn't block it.
2. **Another** editor or approver calls `approve_change()` or `deny_change()`. A denial needs a reason. The reviewer can `reopen_change()` it, and the author can `appeal_change()` with a note.
3. Approver A calls `request_publish()`. Approver **B** then calls `confirm_release()`. Rolling back takes the same two steps through `request_rollback()`.
4. If staging changes between A's request and B's confirmation, the confirmation is refused, so B always signs off on exactly what A saw.

Rows are never deleted. They're retired with `active = false`. The logs and releases are append-only, and that holds even for the database owner.

### Who is calling

After CAS sign-in, the app runs `SET LOCAL app.asurite = '<asurite>'` in every transaction. Functions read the caller from there with `me()`, never from an argument.

| Role | What it can do |
|---|---|
| `deskmanual_app` | The website. Reads everything, but changes things only through the functions. |
| `deskmanual_reader` | The assistant. Reads `live.*` only. |

### Contacts

A contact is stored once in `contact`, with its numbers and emails in `contact_method`. It's attached to a zone, trade, building, task or article through `contact_link`, with the role (supervisor, primary, backup, on_call, info) and optional days and hours.

After-hours coverage uses `rotation` and `rotation_slot`. `live.who_to_call` returns who to call right now, with the cell number first. `mark_unavailable()` marks someone off for today only, with no release needed.

## Set up a database

```powershell
pip install openpyxl "psycopg[binary]"
python db/setup.py --dsn "postgresql://<owner>:<pass>@<host>:5432/deskmanual" `
    --workbook "Desk Manual 2027.xlsx" --admin <your asurite> --admin-name "<your name>"
```

`setup.py` does all of this in order:

1. Runs the schema.
2. Makes you admin.
3. Runs the core import: buildings, zones and routing, from `buildings_lookup.json` and `firstCallExamples_enriched.json`.
4. Imports every other sheet as an article, reading the workbook at run time.
5. Publishes v1. That's the only release allowed with one sign-off.

The workbook and the article text are **never saved to the repo**, because they contain staff contact details.

Then create the login roles the app and the assistant will use:

```sql
CREATE ROLE desk_web LOGIN PASSWORD '...' IN ROLE deskmanual_app;
CREATE ROLE desk_ai  LOGIN PASSWORD '...' IN ROLE deskmanual_reader;
```

## Test the rules (throwaway database only)

```powershell
python db/test_rules.py --dsn "postgresql://.../deskmanual_test"
```

This runs 51 checks of the user-story rules, all made through the app's role. It covers peer review, appeals, conflict warnings, two-person publish and rollback, who-to-call, rights, flags, and the absence of back doors.

## Review the import (story 10.2)

```sql
-- what each sheet became, and what to check by hand
SELECT sheet_name, target, status, warnings FROM import_sheet ORDER BY sheet_name;
-- mark one checked (approver/admin)
SELECT review_import('Radio Protocol', 'reviewed', 'matches the Excel');
```

## Useful queries

```sql
SELECT * FROM live.routing_lookup WHERE description = 'Plumbing - GENERAL';  -- where does a task go?
SELECT * FROM live.building_lookup WHERE code = '157A';                       -- zones for a building
SELECT * FROM live.who_to_call WHERE target_table = 'zone' AND target_key = 'ACAD A';
SELECT * FROM release_checks();                                               -- what would block a publish
SELECT version, label, published_by, confirmed_by, is_live FROM release ORDER BY version DESC;
SELECT * FROM activity ORDER BY at DESC LIMIT 50;                             -- story 7.4
```
