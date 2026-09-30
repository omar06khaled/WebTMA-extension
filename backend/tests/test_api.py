"""Backend tests. The OpenAI and Supabase calls are faked, so these run offline and cost nothing.

Run from the repo root:  python -m pytest backend/tests -q
"""

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def load_app(tmp_path, monkeypatch):
    def _load(layer2=False):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        monkeypatch.setenv("AUDIT_LOG_PATH", str(tmp_path / "audit.log"))
        monkeypatch.setenv("LAYER2_ENABLED", "true" if layer2 else "false")
        monkeypatch.setenv("LAYER2_URL", "https://example.invalid/layer2")
        monkeypatch.setenv("SUPABASE_ANON_KEY", "test-anon")
        sys.modules.pop("main", None)
        module = importlib.import_module("main")
        return module, TestClient(module.app)

    return _load


def fake_completion(content, finish_reason="stop"):
    message = SimpleNamespace(content=content)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)], usage=None)


def queue_model_replies(module, monkeypatch, *replies):
    """Each reply is a dict (sent as JSON), a raw string, or a (content, finish_reason) tuple."""
    calls = []
    pending = list(replies)

    async def create(**kwargs):
        calls.append(kwargs)
        reply = pending.pop(0)
        if isinstance(reply, tuple):
            return fake_completion(*reply)
        return fake_completion(reply if isinstance(reply, str) else json.dumps(reply))

    monkeypatch.setattr(module.openai_client.chat.completions, "create", create)
    return calls


def kb_suggestion(module, description, confidence=0.9):
    """A suggestion built straight from the knowledge base, so it should always validate."""
    for category, tasks in module.KNOWLEDGE_BASE.items():
        if description in tasks:
            entry = tasks[description]
            return {
                "taskCode": entry["taskCode"],
                "taskDescription": description,
                "category": category,
                "tradeOptions": {c: module.format_trade_for_suggestion(t) for c, t in entry["trade"].items()},
                "notes": entry["notes"],
                "confidence": confidence,
                "matchedOn": "keyword: test",
            }
    raise KeyError(description)


def pick(description, category=None, confidence=0.9, **extra):
    """What the model returns for one suggestion. The backend builds the rest from the knowledge base."""
    return {"taskDescription": description, "category": category, "confidence": confidence, "matchedOn": "keyword: test", **extra}


# ------------------------------------------------------------------ /api/suggest


def test_rejects_missing_or_short_input(load_app):
    _, client = load_app()
    assert client.post("/api/suggest", json={}).json() == {"error": "actionRequested is required and must be a string"}
    assert client.post("/api/suggest", json={"actionRequested": 5}).status_code == 400
    response = client.post("/api/suggest", json={"actionRequested": "ab"})
    assert response.status_code == 400 and response.json() == {"error": "actionRequested too short"}
    assert client.post("/api/suggest", content=b"not json", headers={"Content-Type": "application/json"}).status_code == 400


def test_valid_suggestion_passes_and_is_audited(load_app, monkeypatch):
    module, client = load_app()
    good = kb_suggestion(module, "Lighting")
    calls = queue_model_replies(module, monkeypatch, {"suggestions": [pick("Lighting", "Electrical")], "noMatchFound": False, "lowConfidenceWarning": False})

    body = client.post("/api/suggest", json={"actionRequested": "lightbulb burnt out in room 101"}).json()

    assert body["suggestions"] == [good]
    assert body["noMatchFound"] is False and body["lowConfidenceWarning"] is False
    assert isinstance(body["auditTimestamp"], str) and "layer2" not in body
    assert calls[0]["model"] == "gpt-4o-mini"
    assert calls[0]["response_format"] == {"type": "json_object"}
    prompt = calls[0]["messages"][1]["content"]
    assert '"trade"' not in prompt and "RFMT-ZONE-1" not in prompt  # trades never go to the model
    assert len(prompt) < 20000

    entry = json.loads(module.AUDIT_LOG_PATH.read_text().strip())
    assert entry["suggestionsReturned"] == ["Lighting"] and entry["layer"] == 1 and entry["appliedSuggestion"] is None


def test_model_env_var_overrides_default(load_app, monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4.1-mini")
    module, client = load_app()
    calls = queue_model_replies(module, monkeypatch, {"suggestions": [], "noMatchFound": True})
    client.post("/api/suggest", json={"actionRequested": "anything at all"})
    assert calls[0]["model"] == "gpt-4.1-mini"


def test_invented_or_malformed_picks_are_dropped(load_app, monkeypatch):
    module, client = load_app()
    picks = [
        pick("Toilet", "Plumbing"),
        pick("Clogged Sink Special", "Plumbing"),
        pick("Sink", "Plumbing", confidence=1.5),
        {"taskDescription": "Drain", "category": "Plumbing", "confidence": 0.8},  # no matchedOn
    ]
    queue_model_replies(module, monkeypatch, {"suggestions": picks, "noMatchFound": False})

    body = client.post("/api/suggest", json={"actionRequested": "toilet keeps running"}).json()

    assert [s["taskDescription"] for s in body["suggestions"]] == ["Toilet"]
    errors = json.loads(module.AUDIT_LOG_PATH.read_text().strip())["validationErrors"]
    assert any("not found in knowledge base" in e for e in errors)
    assert any("confidence must be a number between 0 and 1" in e for e in errors)
    assert any("matchedOn" in e for e in errors)


def test_codes_and_trades_always_come_from_the_knowledge_base(load_app, monkeypatch):
    """Whatever the model says about codes or trades is ignored (this is what broke 'Thermostat')."""
    module, client = load_app()
    garbage = pick("Thermostat", "Residential Facilities", taskCode=99999, tradeOptions={"rfmtPoly": {"type": "ZONE"}})
    queue_model_replies(module, monkeypatch, {"suggestions": [garbage], "noMatchFound": False})

    body = client.post("/api/suggest", json={"actionRequested": "dorm thermostat broken"}).json()

    expected = kb_suggestion(module, "Thermostat")
    got = body["suggestions"][0]
    assert got["taskCode"] == expected["taskCode"] and got["tradeOptions"] == expected["tradeOptions"]
    assert all(v is None or isinstance(v, str) for v in got["tradeOptions"].values())


def test_task_without_a_code_is_still_suggested(load_app, monkeypatch):
    module, client = load_app()
    no_code = [(c, d) for c, t in module.KNOWLEDGE_BASE.items() for d, e in t.items() if e["taskCode"] is None]
    assert no_code, "expected some tasks with no code in the manual (e.g. Fire extinguisher)"
    category, description = no_code[0]
    queue_model_replies(module, monkeypatch, {"suggestions": [pick(description, category)], "noMatchFound": False})

    body = client.post("/api/suggest", json={"actionRequested": "anything"}).json()

    assert body["suggestions"][0]["taskDescription"] == description
    assert body["suggestions"][0]["taskCode"] is None


def test_category_picks_between_shared_descriptions(load_app, monkeypatch):
    module, client = load_app()
    shared = next(d for d in module.ALL_DESCRIPTIONS if sum(d in t for t in module.KNOWLEDGE_BASE.values()) > 1)
    categories = [c for c, t in module.KNOWLEDGE_BASE.items() if shared in t]
    unique = "Toilet"
    queue_model_replies(
        module,
        monkeypatch,
        {"suggestions": [pick(shared, categories[1]), pick(shared, None), pick(unique, "Wrong Category"), pick(unique, "Plumbing")], "noMatchFound": False},
    )

    body = client.post("/api/suggest", json={"actionRequested": "something shared"}).json()

    got = [(s["category"], s["taskDescription"]) for s in body["suggestions"]]
    assert got == [(categories[1], shared), ("Plumbing", unique)]  # ambiguous one dropped, wrong category fixed, repeat removed


def test_all_invalid_means_no_match(load_app, monkeypatch):
    module, client = load_app()
    queue_model_replies(module, monkeypatch, {"suggestions": [{"taskDescription": "nope"}], "noMatchFound": False, "lowConfidenceWarning": True})
    body = client.post("/api/suggest", json={"actionRequested": "something odd"}).json()
    assert body["suggestions"] == [] and body["noMatchFound"] is True and body["lowConfidenceWarning"] is False


@pytest.mark.parametrize(
    "reply, expected_error",
    [
        (("{\"suggestions\": [", "length"), "AI response was cut off before it finished"),
        ("", "AI returned no answer"),
        ("this is not json", "AI returned unparseable JSON"),
        ({"suggestions": "nope"}, "AI response failed schema check"),
    ],
)
def test_model_failures_return_502_with_detail(load_app, monkeypatch, reply, expected_error):
    module, client = load_app()
    queue_model_replies(module, monkeypatch, reply)
    response = client.post("/api/suggest", json={"actionRequested": "leaking pipe"})
    assert response.status_code == 502
    assert response.json()["error"] == expected_error
    assert response.json()["detail"]  # the side panel shows this text


def test_model_unreachable_returns_502(load_app, monkeypatch):
    module, client = load_app()

    async def boom(**kwargs):
        raise module.APITimeoutError(request=None)

    monkeypatch.setattr(module.openai_client.chat.completions, "create", boom)
    response = client.post("/api/suggest", json={"actionRequested": "leaking pipe"})
    assert response.status_code == 502 and response.json()["error"] == "AI API unreachable"


# ------------------------------------------------------------------ Layer 2


def enable_fake_search(module, monkeypatch, sheets=("TMPE Zone Guide",)):
    async def search(query):
        return [{"sheet": s, "content": f"[{s}]\nsome excerpt"} for s in sheets]

    monkeypatch.setattr(module, "search_desk_manual", search)


def test_layer2_runs_when_layer1_is_weak(load_app, monkeypatch):
    module, client = load_app(layer2=True)
    enable_fake_search(module, monkeypatch, sheets=("TMPE Zone Guide", "Shop Priorities"))
    queue_model_replies(
        module,
        monkeypatch,
        {"suggestions": [pick("Lighting", "Electrical", confidence=0.6)], "noMatchFound": False},
        {"guidance": "Send it to the zone.", "citedSheets": ["TMPE Zone Guide", "Made Up Sheet"], "taskDescription": "Lighting", "confidence": 0.7},
    )

    body = client.post("/api/suggest", json={"actionRequested": "dim lights in hallway"}).json()

    assert body["layer2"]["citedSheets"] == ["TMPE Zone Guide"]  # the invented sheet is dropped
    suggestion = body["layer2"]["suggestion"]
    assert suggestion["taskCode"] == module.KNOWLEDGE_BASE["Electrical"]["Lighting"]["taskCode"]
    assert suggestion["matchedOn"] == "desk manual: TMPE Zone Guide"
    assert json.loads(module.AUDIT_LOG_PATH.read_text().strip())["layer"] == 2


def test_layer2_skipped_when_layer1_is_confident(load_app, monkeypatch):
    module, client = load_app(layer2=True)
    enable_fake_search(module, monkeypatch)
    calls = queue_model_replies(module, monkeypatch, {"suggestions": [pick("Lighting", "Electrical", 0.95)], "noMatchFound": False})
    body = client.post("/api/suggest", json={"actionRequested": "light out"}).json()
    assert "layer2" not in body and len(calls) == 1


def test_layer2_failure_falls_back_to_layer1(load_app, monkeypatch):
    module, client = load_app(layer2=True)

    async def broken_search(query):
        raise RuntimeError("search HTTP 500")

    monkeypatch.setattr(module, "search_desk_manual", broken_search)
    queue_model_replies(module, monkeypatch, {"suggestions": [], "noMatchFound": True})
    response = client.post("/api/suggest", json={"actionRequested": "weird request"})
    assert response.status_code == 200 and "layer2" not in response.json()


def test_layer2_ambiguous_description_gives_no_suggestion(load_app, monkeypatch):
    module, client = load_app(layer2=True)
    enable_fake_search(module, monkeypatch)
    ambiguous = next(
        d for d in {d for t in module.KNOWLEDGE_BASE.values() for d in t}
        if sum(d in t for t in module.KNOWLEDGE_BASE.values()) > 1
    )
    queue_model_replies(
        module,
        monkeypatch,
        {"suggestions": [], "noMatchFound": True},
        {"guidance": "g", "citedSheets": ["TMPE Zone Guide"], "taskDescription": ambiguous, "confidence": 0.9},
    )
    body = client.post("/api/suggest", json={"actionRequested": "something ambiguous"}).json()
    assert body["layer2"]["suggestion"] is None


# ------------------------------------------------------------------ audit + buildings + CORS


def test_audit_applied_updates_matching_entry(load_app, monkeypatch):
    module, client = load_app()
    queue_model_replies(module, monkeypatch, {"suggestions": [pick("Lighting", "Electrical")], "noMatchFound": False})
    timestamp = client.post("/api/suggest", json={"actionRequested": "light out"}).json()["auditTimestamp"]

    assert client.post("/api/audit/applied", json={"auditTimestamp": timestamp, "appliedSuggestion": "Lighting"}).json() == {"ok": True}
    assert json.loads(module.AUDIT_LOG_PATH.read_text().strip())["appliedSuggestion"] == "Lighting"
    assert client.post("/api/audit/applied", json={"auditTimestamp": "nope", "appliedSuggestion": "x"}).status_code == 404
    assert client.post("/api/audit/applied", json={"appliedSuggestion": "x"}).status_code == 400


def test_building_search(load_app):
    module, client = load_app()
    assert client.get("/api/building-search", params={"q": "a"}).json() == []
    code = module.BUILDINGS[0]["bldgCode"]
    assert client.get("/api/building-search", params={"q": code.lower()}).json()[0]["bldgCode"] == code
    results = client.get("/api/building-search", params={"q": "hall"}).json()
    assert 0 < len(results) <= 8 and set(results[0]) == {"name", "bldgCode", "rateSchedule", "sector", "campus"}


def test_building_zones_come_from_the_2027_guide(load_app):
    _, client = load_app()
    bulldog = client.get("/api/building-search", params={"q": "bulldog"}).json()[0]
    assert (bulldog["sector"], bulldog["campus"]) == ("ACAD A", "tempe")  # was TMPE-B02 before the 2027 guide


def test_cors_allows_only_the_extension(load_app):
    _, client = load_app()
    ok = client.options("/api/suggest", headers={"Origin": "chrome-extension://abc", "Access-Control-Request-Method": "POST"})
    assert ok.headers.get("access-control-allow-origin") == "chrome-extension://abc"
    blocked = client.options("/api/suggest", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in blocked.headers


def test_every_knowledge_base_entry_validates_against_itself(load_app):
    """Guards the manual-to-JSON conversion: every entry, with or without a code, must pass validation."""
    module, _ = load_app()
    failures = {}
    for tasks in module.KNOWLEDGE_BASE.values():
        for description, entry in tasks.items():
            if sum(description in t for t in module.KNOWLEDGE_BASE.values()) > 1:
                continue  # duplicates across categories are checked by the Layer 2 ambiguity test
            errors = module.validate_suggestion(kb_suggestion(module, description))
            if errors:
                failures[description] = errors
    assert failures == {}
