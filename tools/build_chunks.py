"""Build chunks.jsonl (Layer 2 desk manual excerpts) from the desk manual.

Usage:
    python tools/build_chunks.py "Desk Manual 2027.xlsx" [--out chunks.jsonl]

Each chunk is {"sheet", "chunk_index", "content"}; content starts with "[<sheet name>]" followed by
rows joined with " | ". Phone numbers and email addresses are replaced with [phone] / [email]
before anything leaves this machine. Chunks break on row boundaries at about 1200 characters.
Requires: pip install openpyxl
"""

import argparse
import json
import re
import sys

import openpyxl

# Sheets Layer 2 searches. Task codes and trades come from Layer 1, and contact lists,
# maps and classroom lists are left out on purpose.
SHEETS = [
    "Shops Operating and Tools WOs",
    "Shop Priorities",
    "HOTCOLD Calls",
    "DTPC-Aramark RetailDining",
    "POLY-Aramark RetailDining ",
    "TMPE-Aramark RetailDining ",
    "WEST-Aramark RetailDining ",
    "Janitorial",  # was "Custodial" in the 2025 manual
    "Janitorial Zone Guide",  # was "Custodial Zone Guide"
    "Fulton Cleaning",
    "Emergency Utility",
    "Elevators-DTPC",
    "Elevators-TMPE",
    "Elevators -  POLY",
    "ELEVATORS-WEST",
    "ISAAC Doors",
    "Memorial Union",
    "Leased Building Contact List",
    "3rd Party Housing",
    "Restoration Companies",
    "Broken Glass",
    "MOM Response Expectations",
    "DTPC RFMT Guide",
    "POLY RFMT Guide",
    "TMPE RFMT Guide",
    "WEST RFMT Guide",
    "DTPC Zone Guide",
    "POLY Zone Guide",
    "TMPE Zone Guide",
    "West Zone Guide",
    "LACA Zone Guide",
    "LKHV Zone Guide",
]
RENAMED_FROM = {"Janitorial": "Custodial", "Janitorial Zone Guide": "Custodial Zone Guide"}

MAX_CHARS = 1200
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE = re.compile(
    r"\+\d{1,3}[\s()0-9-]{8,}\d"  # international, e.g. +44 (0)7867 176471
    r"|(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?)\s*\d+)?"
    r"|\b\d{3}-\d{4}\b"
)


def redact(text):
    return PHONE.sub("[phone]", EMAIL.sub("[email]", text))


def row_text(row):
    cells = [re.sub(r"[ \t]+", " ", str(value)).strip() for value in row if value is not None]
    cells = [cell for cell in cells if cell]
    if not cells or cells == ["BACK"]:
        return ""
    return redact(" | ".join(cells))


def chunk_sheet(sheet_name, rows):
    header = f"[{sheet_name.strip()}]\n"
    chunks, current = [], []
    size = len(header)
    for line in rows:
        while len(header) + len(line) > MAX_CHARS:  # a single huge row gets split
            if current:
                chunks.append(current)
                current, size = [], len(header)
            cut = MAX_CHARS - len(header)
            chunks.append([line[:cut]])
            line = line[cut:]
        if size + len(line) + 1 > MAX_CHARS and current:
            chunks.append(current)
            current, size = [], len(header)
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append(current)
    return [header + "\n".join(lines) for lines in chunks]


def build(path, sheets):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    output, missing = [], []
    for wanted in sheets:
        name = wanted if wanted in workbook.sheetnames else RENAMED_FROM.get(wanted)
        if name not in workbook.sheetnames:
            missing.append(wanted)
            continue
        rows = [text for text in (row_text(r) for r in workbook[name].iter_rows(values_only=True)) if text]
        for index, content in enumerate(chunk_sheet(name, rows)):
            output.append({"sheet": name.strip(), "chunk_index": index, "content": content})
    return output, missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--out", default="chunks.jsonl")
    args = parser.parse_args()

    chunks, missing = build(args.workbook, SHEETS)
    with open(args.out, "w", encoding="utf-8") as handle:
        for chunk in chunks:
            handle.write(json.dumps(chunk, ensure_ascii=False) + "\n")

    sheets = len({chunk["sheet"] for chunk in chunks})
    print(f"Wrote {args.out}: {len(chunks)} chunks from {sheets} sheets")
    if missing:
        print(f"Sheets not found (check for renames): {missing}")
        sys.exit(1)


if __name__ == "__main__":
    main()
