# Desk manual web app

The web app on top of the desk manual database (`db/`). See `docs/web-app-plan.md` for the design.

| Folder | What |
|---|---|
| `api/DeskManual.Api` | ASP.NET Core API (C#, .NET 10). Sign-in, sessions, and every read and write. Thin: the rules live in the database |
| `api/DeskManual.Api.Tests` | xUnit tests that need no database |
| `web/` | React + TypeScript (Vite) |

## What you need

- .NET 10 SDK and Node.js LTS: `winget install Microsoft.DotNet.SDK.10` and `winget install OpenJS.NodeJS.LTS`
- A desk manual database (see `db/README.md`) with two login roles:

```sql
CREATE ROLE desk_web    LOGIN PASSWORD '...' IN ROLE deskmanual_app;     -- editing, admin, sign-in
CREATE ROLE desk_reader LOGIN PASSWORD '...' IN ROLE deskmanual_reader;  -- dispatch and lookups (live only)
```

## Run it locally

`appsettings.Development.json` points at a local Postgres on port 5433 with no passwords. To use another database, override the connection strings with user secrets (never commit passwords):

```powershell
dotnet user-secrets --project api/DeskManual.Api set "ConnectionStrings:App" "Host=...;Database=deskmanual;Username=desk_web;Password=..."
dotnet user-secrets --project api/DeskManual.Api set "ConnectionStrings:Reader" "Host=...;Database=deskmanual;Username=desk_reader;Password=..."
```

Two terminals:

```powershell
dotnet run --project api/DeskManual.Api      # API on http://localhost:5080
cd web; npm install; npm run dev             # web app on http://localhost:5173
```

Open http://localhost:5173. In Development, sign-in is a stand-in form (any ASURITE). A first-time ASURITE becomes a **viewer**. The API refuses to start the stand-in anywhere but Development.

Tests: `dotnet test api/DeskManual.slnx`. The tests that need a database are skipped unless `DESKMANUAL_TEST_DB` points at a **throwaway copy** (they add a flag, and flags can't be deleted):

```powershell
$env:DESKMANUAL_TEST_DB = "Host=127.0.0.1;Port=5433;Database=deskmanual_test"   # desk_web and desk_reader log in to it
dotnet test api/DeskManual.slnx
```

One of them asks every task for all eight cells and checks them against the database's own routing table.

## What the API answers

Everything needs a signed-in person. Reads use the live (published) manual only and never call the AI.

| Endpoint | Answers |
|---|---|
| `GET /api/tasks?q=` | Tasks by description, category or code |
| `GET /api/dispatch/route?taskId=&building=&campus=` | Who gets the call for regular and RFMT WOs, the task, section, building and General Notes, and all eight cells. A building sets the campus and narrows zone answers to its own zones |
| `GET /api/buildings?q=`, `GET /api/buildings/{code}` | Buildings, then one with its zones and notes |
| `GET /api/zones/{code}` | A zone and its buildings |
| `GET /api/trades/{code}` | A trade and the tasks that go to it, by campus and WO type |
| `GET /api/search?q=` | Tasks, buildings, zones, trades and articles in one go |
| `GET /api/manual`, `GET /api/manual/{id}` | The articles' contents, then one article |
| `POST /api/flags` | Flag a mistake: `woNumber` (required), `description`, `targetTable`, `targetKey` |

## Sign-in and sessions

- `Auth:Mode` is `cas` (default) or `dev`. For CAS, set `Auth:ServiceUrl` to the callback URL registered with ASU (`https://<host>/auth/callback`).
- CAS 3.0: `/auth/login` sends people to weblogin; `/auth/callback` checks the ticket server to server, calls `ensure_user`, and issues an HttpOnly session cookie for a working day.
- Every request runs in one transaction that starts with `set_config('app.asurite', ...)`, so the database knows who is calling.
- Anything other than a GET must carry the header `X-Desk-Manual: 1` (blocks cross-site request forgery; `web/src/api.ts` adds it).
- Rule refusals from the database come back as `400 {"error": "..."}`.

## Production build

`npm run build` in `web/` writes into `api/DeskManual.Api/wwwroot`, and the API serves it, so the app and API share one origin. Connection strings and `Auth:ServiceUrl` come from the host's secret store or environment variables (`ConnectionStrings__App`, `ConnectionStrings__Reader`, `Auth__ServiceUrl`).
