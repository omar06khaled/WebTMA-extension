# WebTMA Assistant — AI Guardrails

These rules apply to **every AI interaction** in this project:
the Claude Code coding session AND the Node backend that calls Claude at runtime.

---

## 1. Source of Truth Is the JSON — Always

`firstCallExamples_enriched.json` is the **only** valid source for:

- Task Codes (numeric values)
- Task Descriptions (exact key names in the JSON)
- Trade Descriptions (exact string values per campus key)

Claude **must never invent, guess, or interpolate** a task code or trade that
does not exist verbatim in the JSON.  If no match is found, return
`"NO_MATCH"` — do not return the closest-sounding thing.

---

## 2. Response Schema Is Strict

Every suggestion the backend returns must conform **exactly** to this shape.
No extra fields. No missing fields.

```json
{
  "suggestions": [
    {
      "taskCode": 15040,
      "taskDescription": "Lighting",
      "category": "Electrical",
      "tradeOptions": {
        "dtpc": "DTPC-A01 or DTPC-A02 (Check Zone Guide)",
        "poly": "POLY-A01 (Check Zone Guide)",
        "tempe": "TMPE-A, TMPE-B, or TMPE-C (Check Zone Guide)",
        "west": "WEST-A01 (Check Zone Guide)",
        "rfmtDtpc": "RFMT-TRADE (Check Zone Guide)",
        "rfmtPoly": "RFMT-POLY (Check Zone Guide)",
        "rfmtTmpe": "RFMT-ZONE-1, RFMT-ZONE-2, or RFMT-ZONE-3 (Check Zone Guide)",
        "rfmtWest": "RFMT-LSCS (Check Zone Guide)"
      },
      "notes": "Blue Lights requests - send to the zone first...",
      "confidence": 0.92,
      "matchedOn": "keyword: lighting"
    }
  ],
  "noMatchFound": false,
  "lowConfidenceWarning": false
}
```

If Claude returns anything outside this schema, the backend **rejects the
response and returns a structured error** — it never passes malformed output
to the UI.

---

## 3. Confidence Thresholds

| Confidence | Action |
|---|---|
| ≥ 0.80 | Show suggestion normally |
| 0.50 – 0.79 | Show suggestion with ⚠️ "Low confidence — please verify" badge |
| < 0.50 | Do not show. Return `lowConfidenceWarning: true` and prompt user to clarify |

Claude must include a `confidence` float (0.0–1.0) and a `matchedOn` string
explaining the reasoning (e.g. `"keyword: condensate leak"`,
`"semantic: HVAC cooling issue"`).

---

## 4. Validation Layer in the Backend (Non-Negotiable)

Before any suggestion reaches the UI, `server.js` must run
`validateSuggestion()` against the live JSON:

```js
function validateSuggestion(suggestion, knowledgeBase) {
  const errors = [];

  // 1. Task description must exist as a key somewhere in the JSON
  const allDescriptions = Object.values(knowledgeBase)
    .flatMap(cat => Object.keys(cat));
  if (!allDescriptions.includes(suggestion.taskDescription)) {
    errors.push(`taskDescription "${suggestion.taskDescription}" not found in knowledge base`);
  }

  // 2. Task code must match what the JSON says for that description
  const entry = Object.values(knowledgeBase)
    .flatMap(cat => Object.entries(cat))
    .find(([key]) => key === suggestion.taskDescription);

  if (entry && entry[1].taskCode !== suggestion.taskCode) {
    errors.push(
      `taskCode mismatch: AI said ${suggestion.taskCode}, ` +
      `JSON says ${entry[1].taskCode} for "${suggestion.taskDescription}"`
    );
  }

  // 3. All trade values must appear in the JSON entry for that description
  if (entry) {
    const validTrades = entry[1].trade;
    for (const [campus, tradeVal] of Object.entries(suggestion.tradeOptions)) {
      const jsonTrade = validTrades[campus];
      if (!jsonTrade) continue; // null campus entries are allowed
      const validValues = jsonTrade?.options ?? [jsonTrade];
      if (!validValues.some(v => tradeVal.includes(v))) {
        errors.push(
          `trade mismatch for campus "${campus}": AI said "${tradeVal}", ` +
          `valid values are ${JSON.stringify(validValues)}`
        );
      }
    }
  }

  return errors; // empty array = valid
}
```

If `errors.length > 0`, the suggestion is **dropped** and the error is
logged server-side. The UI receives `noMatchFound: true` with a message
asking the operator to select manually.

---

## 5. Prompt Constraints (System Prompt for Runtime Claude Calls)

Paste this verbatim as the `system` message in every `/api/suggest` call:

```
You are a work order classification assistant for ASU Facilities Management.

RULES — follow all of them exactly:
1. You may only suggest task codes, task descriptions, and trade descriptions
   that exist in the provided knowledge base JSON. Do not invent values.
2. Return only valid JSON matching the specified schema. No prose, no markdown,
   no explanation outside the JSON object.
3. Include a "confidence" float between 0.0 and 1.0.
4. Include a "matchedOn" string that names the keyword or concept that drove
   the match (e.g. "keyword: water leak", "semantic: HVAC temperature issue").
5. If you cannot find a match with confidence ≥ 0.50, set noMatchFound to true
   and return an empty suggestions array.
6. Never combine or merge two different task descriptions into one suggestion.
7. Campus trade values with type "ZONE" must list the zone options exactly as
   they appear in the JSON and append "(Check Zone Guide)".
```

---

## 6. Coding Guardrails (Claude Code Sessions)

These rules apply when using Claude Code to build or modify this project:

### 6a. Never Hard-Code Task Codes or Trade Strings
All task codes and trade values must be read from `firstCallExamples_enriched.json`
at runtime. No magic numbers. No string literals for trade names in application code.

```js
// ❌ WRONG
const taskCode = 15040;
const trade = "HVAC";

// ✅ RIGHT
const entry = knowledgeBase["Electrical"]["Lighting"];
const taskCode = entry.taskCode;
const trade = entry.trade.tempe;
```

### 6b. No Selector Guessing
If a WebTMA DOM selector is uncertain, add a `// TODO: verify selector`
comment and log a warning — never silently fail or silently succeed with a
wrong element.

### 6c. Fill Fields Only With Validated Data
`content.js` must never call `setFieldValue()` with data that has not passed
through `validateSuggestion()` on the backend. The backend is the gatekeeper.

### 6d. No Silent Errors
Every `catch` block must either surface an error to the UI or log to the
background service worker. Swallowing errors masks hallucinations.

```js
// ❌ WRONG
try { ... } catch (_) {}

// ✅ RIGHT
try { ... } catch (err) {
  console.error("[WebTMA Assistant]", err);
  sendErrorToSidePanel(err.message);
}
```

### 6e. Schema Changes Require JSON Validation First
Before adding any new field to the response schema, verify a real example
exists in `firstCallExamples_enriched.json`. Do not extend the schema to
accommodate a hypothetical.

---

## 7. What the UI Must Show the Operator

The side panel must always display:

- ✅ The matched Task Description (exact, from JSON)
- ✅ The Task Code (exact, from JSON)
- ✅ Per-campus Trade options (with zone note if applicable)
- ✅ Any `notes` from the JSON entry
- ⚠️ A confidence badge if confidence < 0.80
- ❌ A "No match found — please select manually" state if `noMatchFound: true`

The Apply button must be **disabled** until the operator has reviewed the
suggestion. It must never auto-fill without a deliberate click.

---

## 8. Logging for Auditing

Every suggestion served must be logged with:

```json
{
  "timestamp": "ISO8601",
  "actionRequested": "original text from operator",
  "suggestionsReturned": ["Lighting", "Exit signs"],
  "validationErrors": [],
  "appliedSuggestion": "Lighting"
}
```

This log is the paper trail that lets supervisors audit what the AI suggested
vs. what the operator actually chose.
