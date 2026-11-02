"""Builds the desk manual database from scratch in one command.

    python db/setup.py --dsn "postgresql://owner:pass@host:5432/deskmanual" \
        --workbook "Desk Manual 2027.xlsx" --admin omnassar --admin-name "Omar Nassar"

Steps, in order (stops at the first failure, nothing half-done is left behind in a step):
  1. db/schema.sql           tables, functions, checks, database roles
  2. you as the first admin  (the only account that isn't created by signing in)
  3. db/import_core.py       buildings, zones, trades, tasks, routing  (from the repo's JSON)
  4. db/import_articles.py   every other sheet as an article           (from the workbook)
  5. publish v1              the only release with one sign-off; every later one needs two

Run it against an EMPTY database, as the database owner. If it stops part-way, fix the cause and
run the same command again: finished steps are skipped. The app connects as a login role
that is a member of deskmanual_app; the assistant as a member of deskmanual_reader, e.g.
    CREATE ROLE desk_web LOGIN PASSWORD '...' IN ROLE deskmanual_app;
    CREATE ROLE desk_ai  LOGIN PASSWORD '...' IN ROLE deskmanual_reader;

Requires: pip install openpyxl "psycopg[binary]"
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

import psycopg

DB = Path(__file__).resolve().parent


def run(step, *cmd):
    print(f"\n== {step}")
    result = subprocess.run([sys.executable, *cmd])
    if result.returncode:
        sys.exit(f"{step} failed; stopping.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--workbook", required=True, help="the desk manual .xlsx")
    ap.add_argument("--admin", required=True, help="your ASURITE")
    ap.add_argument("--admin-name", required=True)
    ap.add_argument("--no-publish", action="store_true", help="stop before publishing v1")
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Give --dsn or set DATABASE_URL")

    # Each step is all-or-nothing, so a run that stopped part-way can simply be run again:
    # steps that already finished are skipped and it carries on from the one that failed.
    print("== 1. schema")
    with psycopg.connect(args.dsn, autocommit=True) as conn:
        if conn.execute("SELECT to_regclass('public.release')").fetchone()[0]:
            if conn.execute("SELECT count(*) FROM public.release").fetchone()[0]:
                sys.exit("This database is already set up and published. Nothing to do.")
            print("   already there (an earlier run stopped part-way); carrying on")
        else:
            conn.execute((DB / "schema.sql").read_text(encoding="utf-8"))
            print("   ok")

        print("\n== 2. first admin")
        conn.execute("INSERT INTO public.app_user (asurite, display_name, role) VALUES (%s, %s, 'admin') "
                     "ON CONFLICT (asurite) DO NOTHING", (args.admin.lower(), args.admin_name))
        print(f"   {args.admin.lower()} is admin")
        have_core = conn.execute("SELECT count(*) FROM staging.building").fetchone()[0] > 0
        have_articles = conn.execute("SELECT count(*) FROM staging.article").fetchone()[0] > 0

    if have_core:
        print("\n== 3. core import\n   already done")
    else:
        run("3. core import", str(DB / "import_core.py"), "--dsn", args.dsn)
    if have_articles:
        print("\n== 4. articles\n   already done")
    else:
        run("4. articles", str(DB / "import_articles.py"), "--dsn", args.dsn, "--workbook", args.workbook)

    if args.no_publish:
        print("\nStopped before publishing. Preview staging, then run:\n"
              f"  SET app.asurite = '{args.admin.lower()}'; SELECT public.bootstrap_publish('Initial import');")
        return

    print("\n== 5. publish v1")
    with psycopg.connect(args.dsn) as conn:
        conn.execute("SELECT set_config('app.asurite', %s, true)", (args.admin.lower(),))
        version = conn.execute("SELECT public.bootstrap_publish(%s)",
                               (f"Initial import from {Path(args.workbook).stem}",)).fetchone()[0]
        warnings = conn.execute("SELECT checks FROM public.release WHERE version = %s", (version,)).fetchone()[0]
        print(f"   published v{version} with {len(warnings)} warning(s) to look at (SELECT * FROM release_checks())")


if __name__ == "__main__":
    main()
