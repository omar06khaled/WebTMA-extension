"""Run the eval set through the backend with the real model and print a scorecard.

Usage (from the repo root, with OPENAI_API_KEY in .env):
    python backend/eval_model.py                 # all cases in backend/eval_cases.json
    python backend/eval_model.py --limit 5       # quick smoke test

Each case lists the task descriptions that count as correct ("accept"). An empty list means
the right answer is "no match". Results are also written to backend/eval_results.json.
The expected answers are a starting point: review and edit eval_cases.json to match desk practice.
"""

import argparse
import json
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

usage = {"prompt": 0, "completion": 0, "calls": 0}
_create = main.openai_client.chat.completions.create


async def counting_create(**kwargs):
    response = await _create(**kwargs)
    if response.usage:
        usage["prompt"] += response.usage.prompt_tokens
        usage["completion"] += response.usage.completion_tokens
    usage["calls"] += 1
    return response


main.openai_client.chat.completions.create = counting_create


def grade(case, body):
    accept = case["accept"]
    names = [s["taskDescription"] for s in body.get("suggestions", [])]
    layer2 = (body.get("layer2") or {}).get("suggestion")
    if not accept:
        return ("PASS" if body.get("noMatchFound") else "FAIL"), names
    if names and names[0] in accept:
        return "PASS", names
    if any(n in accept for n in names) or (layer2 and layer2["taskDescription"] in accept):
        return "PARTIAL", names
    return "FAIL", names


def main_cli():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    cases = json.loads((BACKEND / "eval_cases.json").read_text(encoding="utf-8"))[: args.limit]
    client = TestClient(main.app)
    results, counts = [], {"PASS": 0, "PARTIAL": 0, "FAIL": 0, "ERROR": 0}

    print(f"Model: {main.OPENAI_MODEL} | Layer 2: {'on' if main.LAYER2_ENABLED else 'off'} | {len(cases)} cases\n")
    for number, case in enumerate(cases, start=1):
        start = time.monotonic()
        response = client.post("/api/suggest", json={"actionRequested": case["text"]})
        seconds = time.monotonic() - start
        body = response.json()
        if response.status_code != 200:
            verdict, names = "ERROR", [f"{body.get('error')}: {body.get('detail')}"]
        else:
            verdict, names = grade(case, body)
        counts[verdict] += 1
        layer2 = " +L2" if "layer2" in body else ""
        print(f"{number:>2}. {verdict:<7} {seconds:4.1f}s{layer2}  {case['text'][:55]!r}")
        if verdict != "PASS":
            print(f"      got: {names or 'no match'} | expected: {case['accept'] or 'no match'}")
        results.append({**case, "verdict": verdict, "got": names, "status": response.status_code, "seconds": round(seconds, 2), "response": body})

    total = len(cases)
    print(f"\nPASS {counts['PASS']}/{total}  PARTIAL {counts['PARTIAL']}  FAIL {counts['FAIL']}  ERROR {counts['ERROR']}")
    print(f"Tokens: {usage['prompt']:,} in / {usage['completion']:,} out over {usage['calls']} model calls")
    (BACKEND / "eval_results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print("Details written to backend/eval_results.json")


if __name__ == "__main__":
    main_cli()
