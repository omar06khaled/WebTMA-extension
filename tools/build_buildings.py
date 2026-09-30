"""Update buildings_lookup.json (building search) with the zones in a desk manual's zone guides.

Usage:
    python tools/build_buildings.py "Desk Manual 2027.xlsx" [--buildings buildings_lookup.json] [--out buildings_lookup.json]

Starts from the existing building list (names, codes, subtypes) and, for every building a
zone guide lists, sets:
    sector        the zone from the guide, e.g. "ACAD A" (two zones joined with " / " when the
                  guide lists the building twice; an RFMT sector is kept in front of the zone)
    rateSchedule  from the guide when it gives one
    campus        tempe | dtpc | poly | west (the side panel uses it to narrow the trade)
    zoneSource    "2027 zone guide" (the guide's year is taken from --label)
Buildings a guide lists that the old file doesn't have are added. Buildings whose old sector
was a zone the new guide renamed (TMPE-A/B/C/E.., DTPC-A02) but that the guide no longer
lists get sector "Not in <label> - check" so a stale zone is never shown.
Requires: pip install openpyxl
"""

import argparse
import collections
import json
import re

import openpyxl

# sheet -> (campus, [(text in a header row, zone label or None to stop)])
GUIDES = {
    "TMPE Zone Guide": ("tempe", [
        ("ACADEMIC A", "ACAD A"), ("ACADEMIC B", "ACAD B"), ("ATHLETICS", "ATHL"),
        ("RESEARCH A", "RSCH A"), ("RESEARCH B", "RSCH B"), ("GLOBAL SHOP CONTACTS", None),
    ]),
    "DTPC Zone Guide": ("dtpc", [("DTPC-A01", "DTPC-A01")]),
    "POLY Zone Guide": ("poly", [("POLY A-01", "POLY-A01"), ("LOCK SHOP", None), ("RESEARCH A", "RSCH A")]),
    "West Zone Guide": ("west", [("WEST - ZONE A", "WEST-A01"), ("WEST-GRNDS", None)]),
}
# Old sectors that name a zone the 2027 guides replaced.
RENAMED_SECTOR = re.compile(r"^(TMPE-[ABCE]\d*|DTPC-A02.*)$")


def norm_code(code):
    code = str(code).strip().upper()
    if re.fullmatch(r"\d+\.0", code):
        code = code[:-2]
    if re.fullmatch(r"\d+", code):
        code = code.zfill(3)
    return code


def clean(value):
    return re.sub(r"\s+", " ", str(value)).strip() if value is not None else ""


def read_guides(path):
    """Returns {code: {"name", "rate", "campus", "zones": [..]}} from the zone guide sheets."""
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    found = {}
    for sheet, (campus, headers) in GUIDES.items():
        if sheet not in workbook.sheetnames:
            raise SystemExit(f"Sheet {sheet!r} not found - check for a rename")
        zone = None
        for row in workbook[sheet].iter_rows(values_only=True):
            cells = [clean(c) for c in row] + [""] * 6
            rate, code, name = cells[0], cells[1], cells[2]
            if not code:
                joined = " ".join(cells).upper()
                for text, label in headers:
                    if text in joined:
                        zone = label
                continue
            if zone is None or not name or code.upper().startswith("BLDG"):
                continue
            entry = found.setdefault(norm_code(code), {"name": name, "rate": "", "campus": campus, "zones": []})
            if zone not in entry["zones"]:
                entry["zones"].append(zone)
            if rate in ("CM", "CB", "CM/CB") and not entry["rate"]:
                entry["rate"] = rate
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--buildings", default="buildings_lookup.json")
    parser.add_argument("--out", default="buildings_lookup.json")
    parser.add_argument("--label", default="2027 zone guide")
    args = parser.parse_args()

    guide = read_guides(args.workbook)
    with open(args.buildings, encoding="utf-8") as handle:
        buildings = json.load(handle)

    seen, stats = set(), collections.Counter()
    for building in buildings:
        code = norm_code(building.get("bldgCode") or "")
        old = building.get("sector") or ""
        if code in guide:
            info = guide[code]
            zone = " / ".join(info["zones"])
            building["sector"] = f"{old} / {zone}" if old.startswith("RFMT") else zone
            building["rateSchedule"] = info["rate"] or building.get("rateSchedule")
            building["campus"] = info["campus"]
            building["zoneSource"] = args.label
            seen.add(code)
            stats["updated from guide"] += 1
        elif RENAMED_SECTOR.match(old):
            building["sector"] = f"Not in {args.label} - check"
            building["zoneSource"] = f"old sector {old}"
            stats["renamed zone, not in guide"] += 1
        else:
            prefix = old.split("-")[0]
            campus = {"POLY": "poly", "WEST": "west", "DTPC": "dtpc", "TMPE": "tempe"}.get(prefix)
            if campus:
                building["campus"] = campus
            stats["unchanged"] += 1

    for code, info in sorted(guide.items()):
        if code in seen:
            continue
        buildings.append({
            "name": info["name"].upper(),
            "bldgCode": code,
            "rateSchedule": info["rate"] or None,
            "sector": " / ".join(info["zones"]),
            "subtype": None,
            "campus": info["campus"],
            "zoneSource": args.label,
        })
        stats["added from guide"] += 1

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(buildings, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"Wrote {args.out}: {len(buildings)} buildings")
    for key, count in stats.items():
        print(f"  {key}: {count}")
    both = [f"{c} {i['name']} ({' / '.join(i['zones'])})" for c, i in guide.items() if len(i["zones"]) > 1]
    if both:
        print(f"\nListed under two zones ({len(both)}) - shown as both:")
        for line in both:
            print(f"  - {line}")


if __name__ == "__main__":
    main()
