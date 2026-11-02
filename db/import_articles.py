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
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
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


def number_as_shown(v, nf):
    """A number the way its Excel format displays it, for the formats that change the digits:
    percent, currency, thousands, fixed decimals, and digit patterns like phone numbers and ZIP codes.
    Returns None when the format is plain or not one of those."""
    if not nf or nf in ("General", "@") or isinstance(v, bool):
        return None
    for sec in nf.split(";"):                      # "[<=9999999]###-####;(###) ###-####"
        m = re.match(r"\[(<=|>=|<|>|=)(-?[\d.]+)\]", sec)
        if m:
            n = float(m.group(2))
            if not {"<=": v <= n, ">=": v >= n, "<": v < n, ">": v > n, "=": v == n}[m.group(1)]:
                continue
        break
    else:
        return None
    p = re.sub(r"\[\$([^\]\-]*)[^\]]*\]", r"\1", sec)             # [$$-409] -> $
    p = re.sub(r"\[[^\]]*\]|_.|\*.", "", p).replace('"', "").replace("\\", "")
    if not re.search(r"[0#?]", p):                                 # a date or time format, or text
        return None
    if "%" in p:
        v = v * 100
    sign, v = ("-" if v < 0 else ""), abs(v)
    if re.fullmatch(r"[^0#?]*[0#?,]*(?:\.[0#?]+)?[^0#?]*", p):     # one number: 0.00%  $#,##0.00  00000
        prefix, run, suffix = re.match(r"([^0#?]*)([0#?,]*(?:\.[0#?]+)?)(.*)", p).groups()
        whole, _, dec = run.partition(".")
        body = format(v, f",.{len(dec)}f" if "," in whole else f".{len(dec)}f")
        head, dot, tail = body.partition(".")
        head = head.replace(",", "").zfill(whole.count("0")) if "," not in whole else head
        return sign + prefix + head + dot + tail + suffix
    digits, out = str(int(round(v))), []                           # digit pattern: (000) 000-0000
    for ch in reversed(p):
        if ch in "0#?":
            if digits:
                out.append(digits[-1])
                digits = digits[:-1]
            elif ch == "0":
                out.append("0")
        elif ch != ",":
            out.append(ch)
    return sign + digits + "".join(reversed(out))


def sheet_from_location(loc):
    """'Bob''s Notes'!A1 -> Bob's Notes"""
    name = loc.rsplit("!", 1)[0]
    if name.startswith("'") and name.endswith("'") and len(name) >= 2:
        name = name[1:-1].replace("''", "'")
    return name


NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "c": "http://schemas.openxmlformats.org/drawingml/2006/chart"}


def drawings_by_sheet(path):
    """Pictures, charts and shapes (text boxes) on each sheet, read straight from the .xlsx file.
    openpyxl drops shapes and text boxes without a word, and only sees pictures when Pillow is installed."""
    out = {}
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        return out
    with z:
        names = set(z.namelist())

        def rels(part):
            folder, file = posixpath.split(part)
            rel_part = posixpath.join(folder, "_rels", file + ".rels")
            if rel_part not in names:
                return {}
            found = {}
            for r in ET.fromstring(z.read(rel_part)):
                target = r.get("Target", "")
                found[r.get("Id")] = (r.get("Type", ""), target.lstrip("/") if target.startswith("/")
                                      else posixpath.normpath(posixpath.join(folder, target)))
            return found

        if "xl/workbook.xml" not in names:
            return out
        workbook_rels = rels("xl/workbook.xml")
        for sheet in ET.fromstring(z.read("xl/workbook.xml")).iter(f"{{{NS['main']}}}sheet"):
            target = workbook_rels.get(sheet.get(f"{{{NS['r']}}}id"))
            info = {"pictures": 0, "charts": 0, "shapes": []}
            for rel_type, part in (rels(target[1]).values() if target else ()):
                if rel_type.endswith("/drawing") and part in names:
                    drawing = ET.fromstring(z.read(part))
                    info["pictures"] += len(list(drawing.iter(f"{{{NS['xdr']}}}pic")))
                    info["charts"] += len(list(drawing.iter(f"{{{NS['c']}}}chart")))
                    for sp in drawing.iter(f"{{{NS['xdr']}}}sp"):
                        paragraphs = ["".join(t.text or "" for t in p.iter(f"{{{NS['a']}}}t"))
                                      for p in sp.iter(f"{{{NS['a']}}}p")]
                        info["shapes"].append("\n".join(x for x in paragraphs if x.strip()))
            out[sheet.get("name")] = info
    return out


def uncached_formulas(path):
    """Sheets with formulas whose result was never stored (a file made by a script, not saved by Excel).
    Those cells read as blank, so say so instead of dropping them quietly."""
    values = openpyxl.load_workbook(path, data_only=True)
    formulas = openpyxl.load_workbook(path)
    found = {}
    for ws in formulas.worksheets:
        shown = values[ws.title]
        n = sum(1 for row in ws.iter_rows() for c in row
                if isinstance(c.value, str) and c.value.startswith("=") and shown[c.coordinate].value is None)
        if n:
            found[ws.title] = n
    return found


def fmt(value, number_format=None):
    """A cell value as text, the way it reads in Excel."""
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        shown = number_as_shown(value, number_format)
        if shown is not None:
            return shown
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
                sheet = sheet_from_location(loc)
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


def sheet_to_markdown(ws, sheetnames, drawing=None):
    """Returns (markdown, rows_read, warnings). `drawing` is this sheet's entry from drawings_by_sheet()."""
    warnings = []
    lines_out = []
    internal_links = set()
    coloured, colours = 0, set()
    cell_notes = []

    rows = []
    for row in ws.iter_rows():
        cells = []
        for c in row:
            if getattr(c, "comment", None) is not None and (c.comment.text or "").strip():
                cell_notes.append(f"{c.coordinate}: {c.comment.text.strip()}")
            text = fmt(c.value, c.number_format)
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
                    target = sheet_from_location(c.hyperlink.location)
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

    if cell_notes:                                  # Excel "notes" on cells
        lines_out.extend(["", "### Notes on cells"] + [f"- {n}" for n in cell_notes])
        warnings.append(f"{len(cell_notes)} cell note(s) added at the end of the article")
    drawing = drawing or {"pictures": 0, "charts": 0, "shapes": []}
    pictures = max(len(getattr(ws, "_images", [])), drawing["pictures"])
    if pictures:
        warnings.append(f"{pictures} picture(s) or map(s) not imported; attach or link them")
        lines_out.append(f"> This sheet had {pictures} picture(s) or map(s) that weren't imported yet.")
    if drawing["charts"] or getattr(ws, "_charts", []):
        n = max(drawing["charts"], len(getattr(ws, "_charts", [])))
        warnings.append(f"{n} chart(s) not imported")
        lines_out.append(f"> This sheet had {n} chart(s) that weren't imported.")
    boxes = [s for s in drawing["shapes"] if s.strip()]
    if boxes:
        lines_out.extend(["", "### Text boxes on the sheet"] + [f"- {s.strip()}" for s in boxes])
        warnings.append(f"{len(boxes)} text box(es) added at the end of the article; their position is lost")
    if len(drawing["shapes"]) > len(boxes):
        warnings.append(f"{len(drawing['shapes']) - len(boxes)} shape(s) or arrow(s) with no text were not imported")
    if ws.sheet_state != "visible":
        warnings.append(f"sheet is {ws.sheet_state} in Excel; imported anyway")
    hidden_cols = [k for k, d in ws.column_dimensions.items() if d.hidden]
    if hidden_cols:
        warnings.append(f"hidden column(s) {', '.join(hidden_cols)} were imported as normal columns")
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
    drawings = drawings_by_sheet(path)
    uncached = uncached_formulas(path)

    plan = []
    for order, ws in enumerate(wb.worksheets):
        name = ws.title
        if name in SKIP or name in CORE:
            plan.append(dict(sheet=name, target="skipped" if name in SKIP else "core",
                             warnings=[SKIP.get(name) or CORE[name]], rows=None))
            continue
        category, title, toc_order = toc.get(name, (NOT_IN_TOC, name.strip(), 1000 + order))
        body, n_rows, warnings = sheet_to_markdown(ws, wb.sheetnames, drawings.get(name))
        if name not in toc:
            warnings.append("not linked from the table of contents")
        if uncached.get(name):
            warnings.append(f"{uncached[name]} formula cell(s) have no stored result, so they came in blank. "
                            "Open the workbook in Excel, save it, and import again")
        plan.append(dict(sheet=name, target="article", title=title, category=category or NOT_IN_TOC,
                         campus=campus_of(name), body=body, rows=n_rows, warnings=warnings, order=toc_order))

    for sheet in wb.chartsheets:                    # a sheet that is only a chart
        plan.append(dict(sheet=sheet.title, target="skipped", rows=None,
                         warnings=["chart sheet: nothing imported"]))

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
        # (the core import adds one article of its own: the routing sheet's General Notes)
        if cur.execute("SELECT count(*) FROM staging.article WHERE source_sheet <> 'Trades and Task Codes (General Notes)'").fetchone()[0]:
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
