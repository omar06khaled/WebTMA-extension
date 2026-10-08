"""One-time import of the 2027 desk manual into the database's staging (next version) tables.

Reads the cleaned files the existing tools already produce (decision 9):
    buildings_lookup.json             <- tools/build_buildings.py
    firstCallExamples_enriched.json   <- tools/build_knowledge_base.py

Usage (from the repo root, after running db/schema.sql on an empty database):
    python db/import_core.py --dsn "postgresql://user:pass@localhost:5432/deskmanual"
    python db/import_core.py --dsn ... --publish-as <your ASURITE>   # also publishes v1

DATABASE_URL works instead of --dsn. Requires: pip install "psycopg[binary]"

Things it can't decide on its own are printed as QUESTIONS at the end, not guessed silently.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent
IMPORT_USER = "import"

# Sheet column -> (campus, is_rfmt)
COLUMNS = {
    "dtpc": ("dtpc", False), "poly": ("poly", False), "tempe": ("tempe", False), "west": ("west", False),
    "rfmtDtpc": ("dtpc", True), "rfmtPoly": ("poly", True), "rfmtTmpe": ("tempe", True), "rfmtWest": ("west", True),
}

# Zones and their campus. The routing sheet and the zone guides use these names.
ZONES = {
    "DTPC-A01": ("dtpc", False), "POLY-A01": ("poly", False), "WEST-A01": ("west", False),
    "ACAD A": ("tempe", False), "ACAD B": ("tempe", False), "ATHL": ("tempe", False),
    "RSCH A": ("tempe", False), "RSCH B": ("tempe", False),
    "RFMT-TRADE": ("dtpc", True), "RFMT-POLY": ("poly", True), "RFMT-LSCS": ("west", True),
    "RFMT-ZONE-1": ("tempe", True), "RFMT-ZONE-2": ("tempe", True), "RFMT-ZONE-3": ("tempe", True),
}
# Names that appear only in the zone guides. Imported as-is and flagged, not merged.
ZONE_GUIDE_ONLY = {
    "RFMT-S1": ("tempe", True, "Name from the TMPE zone guide. Same zone as RFMT-ZONE-1? Check."),
    "RFMT-S2": ("tempe", True, "Name from the TMPE zone guide. Same zone as RFMT-ZONE-2? Check."),
    "RFMT-S3": ("tempe", True, "Name from the TMPE zone guide. Same zone as RFMT-ZONE-3? Check."),
    "BIOS": (None, False, "No campus in the manual. Check."),
    "LACA": (None, False, "No campus in the manual. Check."),
    "WADC": (None, False, "No campus in the manual. Check."),
}
NOT_IN_GUIDE = "Not in 2027 zone guide - check"


def load(name):
    with open(ROOT / name, encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--publish-as", help="ASURITE of an approver/admin: publish the import as v1")
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Give --dsn or set DATABASE_URL")

    buildings = load("buildings_lookup.json")
    knowledge = load("firstCallExamples_enriched.json")
    questions = []

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        if cur.execute("SELECT count(*) FROM staging.building").fetchone()[0]:
            sys.exit("staging already has data. This importer is for an empty database.")

        cur.execute(
            "INSERT INTO public.app_user (asurite, display_name, role) VALUES (%s, %s, 'viewer') "
            "ON CONFLICT DO NOTHING", (IMPORT_USER, "Initial import from Desk Manual 2027"))

        # ---- zones
        for code, (campus, rfmt) in ZONES.items():
            cur.execute("INSERT INTO staging.zone (code, campus_code, is_rfmt, updated_by) VALUES (%s,%s,%s,%s)",
                        (code, campus, rfmt, IMPORT_USER))
        for code, (campus, rfmt, note) in ZONE_GUIDE_ONLY.items():
            cur.execute("INSERT INTO staging.zone (code, campus_code, is_rfmt, notes, updated_by) "
                        "VALUES (%s,%s,%s,%s,%s)", (code, campus, rfmt, note, IMPORT_USER))
        known_zones = set(ZONES) | set(ZONE_GUIDE_ONLY)

        # ---- buildings (decision 1: one row per code, duplicates merged)
        merged = {}
        for b in buildings:
            code = b["bldgCode"].strip()
            if code in merged:
                kept = merged[code]
                if b["name"] != kept["name"]:
                    questions.append(f"Building {code} has two names: {kept['name']!r} / {b['name']!r}. Kept the first.")
                kept["_sources"].append(b.get("zoneSource"))
                kept["notes"] = list(dict.fromkeys((kept.get("notes") or []) + (b.get("notes") or [])))
                continue
            merged[code] = dict(b, _sources=[b.get("zoneSource")])
        dupes = len(buildings) - len(merged)

        no_zone = 0
        for code, b in merged.items():
            building_id = cur.execute(
                "INSERT INTO staging.building (code, name, campus_code, rate_schedule, subtype, updated_by) "
                "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (code, b["name"], b.get("campus"), b.get("rateSchedule"), b.get("subtype"), IMPORT_USER)).fetchone()[0]

            sector = (b.get("sector") or "").strip()
            if not sector or sector == NOT_IN_GUIDE:
                no_zone += 1
                old = sorted({s.replace("old sector ", "") for s in b["_sources"] if s and s.startswith("old sector")})
                if old:
                    cur.execute("INSERT INTO staging.building_note (building_id, note, updated_by) VALUES (%s,%s,%s)",
                                (building_id, f"Not in the 2027 zone guide. Old sector(s): {', '.join(old)}", IMPORT_USER))
            else:
                for zone in (z.strip() for z in sector.split("/")):
                    if zone not in known_zones:
                        questions.append(f"Building {code}: unknown zone {zone!r}. Skipped.")
                        continue
                    cur.execute("INSERT INTO staging.building_zone (building_id, zone_code, updated_by) VALUES (%s,%s,%s)",
                                (building_id, zone, IMPORT_USER))
            for note in b.get("notes") or []:
                cur.execute("INSERT INTO staging.building_note (building_id, note, updated_by) VALUES (%s,%s,%s)",
                            (building_id, note, IMPORT_USER))

        # ---- trades, categories, tasks, routing (decisions 3 and 4)
        trades = set()
        for tasks in knowledge.values():
            for t in tasks.values():
                for cell in t["trade"].values():
                    if isinstance(cell, str) and cell != "SEE NOTE":
                        trades.add(cell)
        for code in sorted(trades):
            if "/" in code:
                questions.append(f"Trade cell {code!r} names two trades in one cell. Imported as one trade for now.")
            cur.execute("INSERT INTO staging.trade (code, is_global, updated_by) VALUES (%s,%s,%s)",
                        (code, "(Global)" in code, IMPORT_USER))

        counts = {"zone": 0, "trade": 0, "see_note": 0, "not_handled": 0}
        task_total = 0
        for cat_order, (category, tasks) in enumerate(knowledge.items()):
            section_note = next((t["sectionNote"] for t in tasks.values() if t.get("sectionNote")), None)
            category_id = cur.execute(
                "INSERT INTO staging.task_category (name, section_note, sort_order, updated_by) "
                "VALUES (%s,%s,%s,%s) RETURNING id", (category, section_note, cat_order, IMPORT_USER)).fetchone()[0]

            for task_order, (description, t) in enumerate(tasks.items()):
                code, notes = t["taskCode"], t.get("notes")
                if code is not None and not isinstance(code, int):
                    questions.append(f"Task {description!r} has {code!r} as its task code, not a number. "
                                     "Imported with no code and kept the text in its notes.")
                    notes = f"Task code in manual: {code}" + (f"\n{notes}" if notes else "")
                    code = None
                task_id = cur.execute(
                    "INSERT INTO staging.task (task_code, description, category_id, custodial, notes, sort_order, updated_by) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                    (code, description, category_id, t.get("custodial", False), notes,
                     task_order, IMPORT_USER)).fetchone()[0]
                task_total += 1

                for column, (campus, rfmt) in COLUMNS.items():
                    cell = t["trade"].get(column)
                    trade, instruction = None, None
                    if isinstance(cell, dict):
                        kind, instruction = "zone", cell.get("instruction")
                    elif cell == "SEE NOTE":
                        kind = "see_note"
                    elif cell:
                        kind, trade = "trade", cell
                    else:
                        kind = "not_handled"
                    counts[kind] += 1
                    cur.execute(
                        "INSERT INTO staging.routing_rule (task_id, campus_code, is_rfmt, kind, trade_code, instruction, updated_by) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (task_id, campus, rfmt, kind, trade, instruction, IMPORT_USER))

        print(f"buildings: {len(merged)} ({dupes} duplicate rows merged, {no_zone} with no 2027 zone)")
        print(f"zones: {len(known_zones)}   trades: {len(trades)}   categories: {len(knowledge)}   tasks: {task_total}")
        print("routing rules: " + ", ".join(f"{k} {v}" for k, v in counts.items()))

        print("\nChecks on the imported data:")
        rows = cur.execute(
            "SELECT severity, check_name, count(*), (array_agg(detail ORDER BY detail))[1:3] "
            "FROM public.release_checks() GROUP BY 1, 2 ORDER BY 1, 2").fetchall()
        for severity, name, n, examples in rows:
            print(f"  {severity:7} {name}: {n}  e.g. {' / '.join(examples)}")
        if not rows:
            print("  none")

        if args.publish_as:
            version = cur.execute("SELECT public.publish(%s, %s)",
                                  (args.publish_as, "Initial import from Desk Manual 2027")).fetchone()[0]
            print(f"\nPublished v{version}.")

    if questions:
        print("\nQUESTIONS (not guessed):")
        for q in questions:
            print("  - " + q)


if __name__ == "__main__":
    main()
