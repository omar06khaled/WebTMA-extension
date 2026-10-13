import csv
import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "merge_feedback.py"
spec = importlib.util.spec_from_file_location("merge_feedback", SCRIPT)
merge_feedback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge_feedback)


def line(**fields):
    base = {"auditTimestamp": "2026-10-13T10:00:00.000Z", "actionRequested": "light out in 101",
            "kind": "suggestion", "source": "layer1", "taskDescription": "Lighting", "tester": "Omar",
            "verdict": "correct", "reasons": [], "expected": None, "note": None}
    base.update(fields)
    return json.dumps(base)


def write(path, *lines):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_merge_dedupes_keeps_latest_and_builds_outputs(tmp_path, capsys):
    a = write(tmp_path / "omar.jsonl",
              line(timestamp="2026-10-13T10:01:00Z"),
              line(timestamp="2026-10-13T10:02:00Z", verdict="wrong", reasons=["wrong_trade"], expected="Lighting ZONE"),
              "not json")
    b = write(tmp_path / "michael.jsonl",
              line(timestamp="2026-10-13T10:01:00Z"),  # exact duplicate of omar's first line
              line(timestamp="2026-10-13T11:00:00Z", auditTimestamp="2026-10-13T10:59:00.000Z",
                   actionRequested="sewer ejector pump", kind="no_match", source=None, taskDescription=None,
                   tester="Michael", verdict="wrong", expected="Sewer 23120"),
              # legacy line written before 'kind' existed
              json.dumps({"timestamp": "2026-10-13T12:00:00Z", "auditTimestamp": "t3", "actionRequested": "x",
                          "source": "layer2", "taskDescription": "Pump", "tester": None, "verdict": "correct", "reasons": []}))
    out = tmp_path / "out"
    merge_feedback.main([str(a), str(b), "--out", str(out)])

    merged = [json.loads(l) for l in (out / "feedback_merged.jsonl").read_text().splitlines()]
    assert len(merged) == 4  # 5 valid lines, one duplicate
    assert [m["timestamp"] for m in merged] == sorted(m["timestamp"] for m in merged)

    with open(out / "feedback_current.csv", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 3  # Omar's changed answer collapses to its latest line
    lighting = next(r for r in rows if r["taskDescription"] == "Lighting")
    assert lighting["verdict"] == "wrong" and lighting["reasons"] == "wrong_trade"

    candidates = json.loads((out / "eval_candidates.json").read_text())
    assert {c["text"] for c in candidates} == {"light out in 101", "sewer ejector pump"}
    assert next(c for c in candidates if c["text"] == "sewer ejector pump")["was"] == "no match"

    printed = capsys.readouterr().out
    assert "4 unique lines, 3 current ratings, 2 eval candidate(s)" in printed
    assert "1 should have matched" in printed


def test_rerun_on_merged_output_is_stable(tmp_path):
    a = write(tmp_path / "a.jsonl", line(timestamp="2026-10-13T10:01:00Z"))
    out1, out2 = tmp_path / "o1", tmp_path / "o2"
    merge_feedback.main([str(a), "--out", str(out1)])
    merge_feedback.main([str(out1 / "feedback_merged.jsonl"), str(a), "--out", str(out2)])
    assert (out1 / "feedback_merged.jsonl").read_text() == (out2 / "feedback_merged.jsonl").read_text()
