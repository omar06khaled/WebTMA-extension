"""Combine beta-tester feedback files into one place and summarize them.

Each tester's backend writes its own feedback.jsonl. Collect those files (email, USB, shared
folder) and run:

    python tools/merge_feedback.py omar.jsonl michael.jsonl andy.jsonl --out feedback_out

Outputs in --out (default: feedback_out/):
    feedback_merged.jsonl   every unique line from every file, oldest first (the full history)
    feedback_current.csv    the latest answer per rating, opens in Excel
    eval_candidates.json    wrong answers where the tester typed what it should have been,
                            in the eval_cases.json shape; review before copying into the test set

A tester can change an answer, which appends a new line. The current answer for a rating is the
latest line for the same (auditTimestamp, actionRequested, kind, source, taskDescription, tester).
Running the script again on files you already merged is safe: identical lines are counted once.
"""

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

CSV_COLUMNS = [
    "timestamp", "tester", "verdict", "kind", "source", "actionRequested", "taskDescription",
    "taskCode", "category", "reasons", "expected", "note", "model", "auditTimestamp",
]


def read_lines(paths):
    """Yield (path, line_number, entry) for every valid JSON object line, warning on bad lines."""
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            for number, raw in enumerate(handle, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    print(f"warning: {path}:{number} is not valid JSON, skipped", file=sys.stderr)
                    continue
                if not isinstance(entry, dict) or "auditTimestamp" not in entry:
                    print(f"warning: {path}:{number} is not a feedback entry, skipped", file=sys.stderr)
                    continue
                entry.setdefault("kind", "suggestion")  # lines written before no-match feedback existed
                yield path, number, entry


def rating_key(entry):
    return (
        entry.get("auditTimestamp"), entry.get("actionRequested"), entry.get("kind"),
        entry.get("source"), entry.get("taskDescription"), entry.get("tester"),
    )


def merge(paths):
    """Return (all unique entries oldest first, latest entry per rating oldest first)."""
    seen = set()
    unique = []
    for _, _, entry in read_lines(paths):
        fingerprint = json.dumps(entry, sort_keys=True, ensure_ascii=False)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        unique.append(entry)
    unique.sort(key=lambda e: e.get("timestamp") or "")

    current = {}
    for entry in unique:  # oldest first, so later lines win
        current[rating_key(entry)] = entry
    latest = sorted(current.values(), key=lambda e: e.get("timestamp") or "")
    return unique, latest


def eval_candidates(latest):
    out = []
    for entry in latest:
        if entry.get("verdict") == "wrong" and entry.get("expected") and entry.get("actionRequested"):
            out.append({
                "text": entry["actionRequested"],
                "accept": [entry["expected"]],
                "from": f"beta feedback, {entry.get('tester') or 'anonymous'}, {entry.get('timestamp')}",
                "was": entry.get("taskDescription") or "no match",
                "note": entry.get("note"),
            })
    return out


def summarize(latest):
    lines = []
    suggestions = [e for e in latest if e.get("kind") == "suggestion"]
    no_match = [e for e in latest if e.get("kind") == "no_match"]

    def pct(right, total):
        return f"{right}/{total} ({100 * right / total:.0f}%)" if total else "0/0"

    right = sum(e.get("verdict") == "correct" for e in suggestions)
    lines.append(f"Suggestions rated: {pct(right, len(suggestions))} correct")
    for source in ("layer1", "layer2"):
        subset = [e for e in suggestions if e.get("source") == source]
        if subset:
            lines.append(f"  {source}: {pct(sum(e.get('verdict') == 'correct' for e in subset), len(subset))} correct")
    nm_right = sum(e.get("verdict") == "correct" for e in no_match)
    lines.append(f"No-match results rated: {len(no_match)} "
                 f"({nm_right} truly nothing fits, {len(no_match) - nm_right} should have matched)")

    reasons = Counter(r for e in suggestions if e.get("verdict") == "wrong" for r in e.get("reasons") or [])
    if reasons:
        lines.append("Wrong reasons: " + ", ".join(f"{r} x{n}" for r, n in reasons.most_common()))

    by_task = defaultdict(lambda: [0, 0])
    for e in suggestions:
        by_task[e.get("taskDescription")][0] += e.get("verdict") == "correct"
        by_task[e.get("taskDescription")][1] += 1
    worst = sorted(by_task.items(), key=lambda kv: (kv[1][0] / kv[1][1], -kv[1][1]))[:10]
    if worst:
        lines.append("Lowest-scoring tasks:")
        for task, (ok, total) in worst:
            lines.append(f"  {task}: {pct(ok, total)}")
    testers = Counter(e.get("tester") or "anonymous" for e in latest)
    lines.append("Ratings per tester: " + ", ".join(f"{t} {n}" for t, n in testers.most_common()))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=Path, help="feedback.jsonl files from each tester")
    parser.add_argument("--out", type=Path, default=Path("feedback_out"), help="output folder")
    args = parser.parse_args(argv)

    missing = [str(p) for p in args.files if not p.is_file()]
    if missing:
        parser.error(f"not found: {', '.join(missing)}")

    unique, latest = merge(args.files)
    args.out.mkdir(parents=True, exist_ok=True)

    with open(args.out / "feedback_merged.jsonl", "w", encoding="utf-8") as handle:
        for entry in unique:
            handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")

    # utf-8-sig so Excel shows non-ASCII text correctly
    with open(args.out / "feedback_current.csv", "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for entry in latest:
            row = dict(entry)
            row["reasons"] = "; ".join(entry.get("reasons") or [])
            writer.writerow(row)

    candidates = eval_candidates(latest)
    with open(args.out / "eval_candidates.json", "w", encoding="utf-8") as handle:
        json.dump(candidates, handle, indent=1, ensure_ascii=False)
        handle.write("\n")

    print(f"Read {len(args.files)} file(s): {len(unique)} unique lines, {len(latest)} current ratings, "
          f"{len(candidates)} eval candidate(s) -> {args.out}/")
    print(summarize(latest))


if __name__ == "__main__":
    main()
