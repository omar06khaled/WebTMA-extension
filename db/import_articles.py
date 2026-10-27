"""Imports the desk manual's prose and reference sheets as articles (one article per sheet).

Every sheet except the table of contents and the routing sheet becomes a Markdown page in
staging.article. Contact sheets come in as articles for now; merging them into the contact
table needs a person to confirm each duplicate (story 10.3), so that's a separate step.

What can't be carried over is recorded, not dropped silently: pictures, colour-only meaning
and links into other sheets go into public.import_sheet.warnings, so the side-by-side
review (story 10.2) knows where to look.

The workbook is read at run time and written only to the database. Nothing from it is saved
to the repo (the sheets hold staff names, phones and emails, and the repo is public).

Usage (after db/schema.sql and db/import_core.py):
    python db/import_articles.py --dsn ... --workbook "Desk Manual 2027.xlsx"
    python db/import_articles.py --workbook ... --dry-run --show "Radio Protocol"   # no database

Requires: pip install openpyxl "psycopg[binary]"
"""

import argparse
import datetime as dt
import os
import re
import sys
from pathlib import Path

import openpyxl

IMPORT_USER = "import"
SKIP = {"TOC": "table of contents; its sections become article categories"}
CORE = {"Trades and Task Codes": "imported as tasks and routing rules by import_core.py"}
# Sheets whose building -> zone links already come in through buildings_lookup.json.
ZONE_GUIDES = {"DTPC Zone Guide", "LACA Zone Guide", "POLY Zone Guide", "TMPE Zone Guide",
               "West Zone Guide", "LKHV Zone Guide", "Janitorial Zone Guide"}
NOT_IN_TOC = "OTHER (not in the table of contents)"
CAMPUS_PREFIX = [("DTPC", "dtpc"), ("POLY", "poly"), ("TMPE", "tempe"), ("TEMPE", "tempe"), ("WEST", "west")]
BULLET = re.compile(r"^\s*(?:o|•|·|-|\*|▪|➢)\s+")


def fmt(value):
    """A cell value as text, the way it reads in Excel."""
    if value is None:
        return ""
    if isinstance(value, dt.datetime):
        if value.time() == dt.time(0):
            return value.date().isoformat()
        return value.strftime("%Y-%m-%d %I:%M %p").replace(" 0", " ")
    if isinstance(value, dt.time):
        return value.strftime("%I:%M %p").lstrip("0")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def toc_map(wb):
    """sheet name -> (category, display title, order) from the TOC's internal links."""
    found = {}
    if "TOC" not in wb.sheetnames:
        return found
    ws = wb["TOC"]
    # Section headings are the cells with no link; the links under them belong to them.
    heading_for_col = {}
    order = 0
    for row in ws.iter_rows():
        for c in row:
            text = fmt(c.value)
            if not text:
                continue
            if c.hyperlink is None:
                if text.upper() != "TABLE OF CONTENTS":
                    heading_for_col[c.column] = text
                continue
            loc = c.hyperlink.location if c.hyperlink else None
            if loc and "!" in loc:
                sheet = loc.rsplit("!", 1)[0].strip("'")
                category = heading_for_col.get(c.column, "")
                order += 1
                # A sheet listed twice (HOT/COLD under TRADES and ARCHIVE) keeps its first, non-archive home.
                if sheet not in found or found[sheet][0] == "ARCHIVE DOCUMENTS":
                    found[sheet] = (category, text.strip(), order)
    return found


def campus_of(sheet):
    name = sheet.strip().upper()
    for prefix, campus in CAMPUS_PREFIX:
        if name.startswith(prefix):
            return campus
    return None


def md_escape(text):
    return text.replace("|", "\\|").replace("\n", "<br>")


def sheet_to_markdown(ws, sheetnames):
    """Returns (markdown, rows_read, warnings)."""
    warnings = []
    lines_out = []
    internal_links = set()
    coloured, colours = 0, set()

    rows = []
    for row in ws.iter_rows():
        cells = []
        for c in row:
            text = fmt(c.value)
            if not text:
                continue
            if c.row <= 2 and text.upper() == "BACK":       # the "BACK" button to the TOC
                continue
            fill = c.fill.fgColor if c.fill is not None and c.fill.fill_type == "solid" else None
            bold = bool(c.font and c.font.b)
            # Highlighting on plain (non-bold) cells is where colour tends to carry meaning;
            # shaded bold header rows are just styling.
            if fill is not None and not bold:
                key = fill.rgb if fill.type == "rgb" else f"theme {fill.theme}"
                if key not in ("00000000", "FFFFFFFF"):
                    coloured += 1
                    colours.add(key)
            if c.hyperlink is not None:
                if c.hyperlink.target:
                    text = f"[{text}]({c.hyperlink.target})"
                elif c.hyperlink.location:
                    target = c.hyperlink.location.rsplit("!", 1)[0].strip("'")
                    if target in sheetnames and target != ws.title:
                        internal_links.add(target)
                        text = f"{text} (see “{target.strip()}”)"
            cells.append((c.column, text, bold))
        rows.append(cells)

    # Split into blocks at blank rows.
    blocks, current = [], []
    for cells in rows:
        if cells:
            current.append(cells)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)

    for block in blocks:
        multi = sum(1 for r in block if len(r) >= 2)
        if len(block) >= 2 and multi * 2 >= len(block):
            # A table. Columns are every column used in the block; empty ones in between are dropped.
            cols = sorted({col for r in block for col, _, _ in r})
            grid = [[next((t for col, t, _ in r if col == k), "") for k in cols] for r in block]
            header = grid[0]
            lines_out.append("| " + " | ".join(md_escape(h) or " " for h in header) + " |")
            lines_out.append("|" + "---|" * len(cols))
            for r in grid[1:]:
                lines_out.append("| " + " | ".join(md_escape(v) for v in r) + " |")
        else:
            under_heading = False
            for r in block:
                text = " — ".join(t for _, t, _ in r)
                bold = all(b for _, _, b in r)
                if BULLET.match(text):
                    lines_out.append("- " + BULLET.sub("", text))
                elif bold and len(r) == 1 and len(text) <= 120:
                    lines_out.extend(["", "### " + text])
                    under_heading = True
                elif under_heading and len(text) <= 160:
                    lines_out.append(text if re.match(r"^\d+[.)]\s", text) else "- " + text)          # short lines under a heading read as a list
                else:
                    lines_out.append(text + "  ")
        lines_out.append("")

    pictures = len(getattr(ws, "_images", []))
    if pictures:
        warnings.append(f"{pictures} picture(s) or map(s) not imported; attach or link them")
        lines_out.append(f"> This sheet had {pictures} picture(s) or map(s) that weren't imported yet.")
    if coloured:
        warnings.append(f"{coloured} highlighted cell(s) in {len(colours)} colour(s): "
                        "if the colour meant something, write it as text")
    n_rows = sum(1 for r in rows if r)
    if n_rows > 1000:
        warnings.append(f"very large ({n_rows} rows): better as its own table or a link to the source")
    if internal_links:
        warnings.append("links to other sheets: " + ", ".join(sorted(t.strip() for t in internal_links)))
    if ws.title in ZONE_GUIDES:
        warnings.append("building -> zone links also come from buildings_lookup.json; check they agree")
    hidden = [k for k, d in ws.row_dimensions.items() if d.hidden]
    if hidden:
        warnings.append(f"{len(hidden)} hidden row(s) were imported as normal rows")
    if not any(rows):
        warnings.append("sheet has no text (picture or link only)")

    body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines_out)).strip() + "\n"
    return body, n_rows, warnings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--workbook", required=True)
    ap.add_argument("--workbook-name", help='shown on import_sheet rows, e.g. "Desk Manual 2027"')
    ap.add_argument("--dry-run", action="store_true", help="convert and print a summary; no database")
    ap.add_argument("--show", help="with --dry-run: print this sheet's Markdown")
    args = ap.parse_args()

    path = Path(args.workbook)
    book_name = args.workbook_name or re.sub(r"^[0-9a-f]{6,}-", "", path.stem).replace("_", " ")
    wb = openpyxl.load_workbook(path, data_only=True)
    toc = toc_map(wb)

    plan = []
    for order, ws in enumerate(wb.worksheets):
        name = ws.title
        if name in SKIP or name in CORE:
            plan.append(dict(sheet=name, target="skipped" if name in SKIP else "core",
                             warnings=[SKIP.get(name) or CORE[name]], rows=None))
            continue
        category, title, toc_order = toc.get(name, (NOT_IN_TOC, name.strip(), 1000 + order))
        body, n_rows, warnings = sheet_to_markdown(ws, wb.sheetnames)
        if name not in toc:
            warnings.append("not linked from the table of contents")
        plan.append(dict(sheet=name, target="article", title=title, category=category or NOT_IN_TOC,
                         campus=campus_of(name), body=body, rows=n_rows, warnings=warnings, order=toc_order))

    articles = [p for p in plan if p["target"] == "article"]
    if args.dry_run:
        for p in plan:
            extra = f"{p['category']:<36} {len(p.get('body', '')):>7} chars" if p["target"] == "article" else p["target"]
            print(f"{p['sheet'].strip():<34} {extra}  {'; '.join(p['warnings'])}")
        print(f"\n{len(articles)} articles, {sum(len(p['body']) for p in articles):,} characters")
        if args.show:
            hit = next((p for p in articles if p["sheet"].strip() == args.show.strip()), None)
            print("\n" + (hit["body"] if hit else f"No article for {args.show!r}"))
        return

    if not args.dsn:
        sys.exit("Give --dsn or set DATABASE_URL (or use --dry-run)")
    import psycopg
    from psycopg.types.json import Jsonb

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        if cur.execute("SELECT count(*) FROM staging.article").fetchone()[0]:
            sys.exit("staging.article already has rows. This importer is for a fresh database.")
        cur.execute("INSERT INTO public.app_user (asurite, display_name, role) VALUES (%s, %s, 'viewer') "
                    "ON CONFLICT DO NOTHING", (IMPORT_USER, f"Initial import from {book_name}"))
        for p in plan:
            article_id = None
            if p["target"] == "article":
                article_id = cur.execute(
                    "INSERT INTO staging.article (title, category, campus_code, body_md, source_sheet, sort_order, updated_by) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                    (p["title"], p["category"], p["campus"], p["body"], p["sheet"], p["order"], IMPORT_USER)).fetchone()[0]
            cur.execute(
                "INSERT INTO public.import_sheet (sheet_name, workbook, target, article_id, rows_read, warnings) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (p["sheet"], book_name, p["target"], article_id, p["rows"], Jsonb(p["warnings"])))

    warned = [p for p in articles if p["warnings"]]
    print(f"articles: {len(articles)} from {len(wb.worksheets)} sheets "
          f"({sum(1 for p in plan if p['target'] == 'core')} core, {sum(1 for p in plan if p['target'] == 'skipped')} skipped)")
    print(f"sheets with something to check by hand: {len(warned)} (see public.import_sheet)")


if __name__ == "__main__":
    main()
