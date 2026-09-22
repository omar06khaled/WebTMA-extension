// Install dependencies before running:
// npm install express dotenv cors

import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.replace(/^=+/, "").trim();

if (!anthropicApiKey) {
  throw new Error("ANTHROPIC_API_KEY is not set - server cannot start");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const knowledgeBase = JSON.parse(
  fs.readFileSync(path.join(__dirname, "firstCallExamples_enriched.json"), "utf8")
);
const knowledgeEntries = Object.values(knowledgeBase).flatMap((category) => Object.entries(category));
const allDescriptions = knowledgeEntries.map(([description]) => description);
const AUDIT_LOG_PATH = path.join(__dirname, "audit.log");

const buildingsArray = JSON.parse(
  fs.readFileSync(path.join(__dirname, "buildings_lookup.json"), "utf8")
);
const buildingsByCode = {};
const buildingsByName = {};
buildingsArray.forEach(b => {
  if (b.bldgCode) buildingsByCode[b.bldgCode.toUpperCase()] = b;
  if (b.name) buildingsByName[b.name.toUpperCase().trim()] = b;
});

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("chrome-extension://")) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
  })
);

app.use(express.json());

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSuggestion(suggestion) {
  const errors = [];

  if (!isPlainObject(suggestion)) {
    return ["suggestion is not an object"];
  }

  if (!Number.isFinite(suggestion.taskCode)) {
    errors.push("taskCode must be a finite number");
  }

  if (typeof suggestion.taskDescription !== "string" || suggestion.taskDescription.trim() === "") {
    errors.push("taskDescription must be a non-empty string");
  }

  if (typeof suggestion.category !== "string" || suggestion.category.trim() === "") {
    errors.push("category must be a non-empty string");
  }

  if (!isPlainObject(suggestion.tradeOptions)) {
    errors.push("tradeOptions must be an object keyed by campus");
  }

  if (
    suggestion.notes !== undefined &&
    suggestion.notes !== null &&
    typeof suggestion.notes !== "string"
  ) {
    errors.push("notes must be a string when provided");
  }

  if (!Number.isFinite(suggestion.confidence)) {
    errors.push("confidence must be a finite number");
  }

  if (typeof suggestion.matchedOn !== "string" || suggestion.matchedOn.trim() === "") {
    errors.push("matchedOn must be a non-empty string");
  }

  if (errors.length > 0) {
    return errors;
  }

  if (!allDescriptions.includes(suggestion.taskDescription)) {
    errors.push(`taskDescription "${suggestion.taskDescription}" not found in knowledge base`);
  }

  const entry = knowledgeEntries.find(([description]) => description === suggestion.taskDescription);

  if (entry && entry[1].taskCode !== suggestion.taskCode) {
    errors.push(
      `taskCode mismatch: AI said ${suggestion.taskCode}, ` +
      `JSON says ${entry[1].taskCode} for "${suggestion.taskDescription}"`
    );
  }

  if (entry) {
    const validTrades = entry[1].trade ?? {};

    for (const [campus, tradeVal] of Object.entries(suggestion.tradeOptions)) {
      const jsonTrade = validTrades[campus];
      if (jsonTrade == null) {
        if (tradeVal == null) continue;

        errors.push(
          `trade mismatch for campus "${campus}": expected null because knowledge base has no trade`
        );
        continue;
      }

      if (typeof tradeVal !== "string") {
        errors.push(`trade mismatch for campus "${campus}": trade value must be a string`);
        continue;
      }

      const validValues = Array.isArray(jsonTrade?.options) ? jsonTrade.options : [jsonTrade];
      if (!validValues.some((value) => typeof value === "string" && tradeVal.includes(value))) {
        errors.push(
          `trade mismatch for campus "${campus}": AI said "${tradeVal}", ` +
          `valid values are ${JSON.stringify(validValues)}`
        );
      }
    }
  }

  return errors;
}

function appendAuditEntry(entry) {
  fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

function stripMarkdownFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

app.post("/api/suggest", async (req, res) => {
  const startTime = Date.now();
  const { actionRequested } = req.body ?? {};

  if (actionRequested === undefined || typeof actionRequested !== "string") {
    return res.status(400).json({
      error: "actionRequested is required and must be a string",
    });
  }

  if (actionRequested.length < 3) {
    return res.status(400).json({ error: "actionRequested too short" });
  }

  const timestamp = new Date().toISOString();
  console.log(
    `[WebTMA SERVER] POST /api/suggest - ${timestamp} - ${actionRequested.slice(0, 80)}`
  );

  const systemPrompt = `You are a work order classification assistant for ASU Facilities Management.

RULES - follow all of them exactly:
1. You may only suggest task codes, task descriptions, and trade descriptions
   that exist in the provided knowledge base JSON. Do not invent values.
2. Return only valid JSON matching the specified schema. No prose, no markdown,
   no explanation outside the JSON object.
3. Include a "confidence" float between 0.0 and 1.0.
4. Include a "matchedOn" string that names the keyword or concept that drove
   the match (e.g. "keyword: water leak", "semantic: HVAC temperature issue").
5. If you cannot find a match with confidence >= 0.50, set noMatchFound to true
   and return an empty suggestions array.
6. Never combine or merge two different task descriptions into one suggestion.
7. Campus trade values with type "ZONE" must list the zone options exactly as
   they appear in the JSON and append "(Check Zone Guide)".
8. If a campus trade value is null in the JSON, return null for that campus.`;

  const responseSchema = `{
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
        "rfmtDtpc": null,
        "rfmtPoly": null,
        "rfmtTmpe": null,
        "rfmtWest": null
      },
      "notes": "Blue Lights requests - send to the zone first...",
      "confidence": 0.92,
      "matchedOn": "keyword: lighting"
    }
  ],
  "noMatchFound": false,
  "lowConfidenceWarning": false
}`;

  const userMessage =
    `KNOWLEDGE BASE:\n${JSON.stringify(knowledgeBase)}\n\n` +
    `ACTION REQUESTED:\n${actionRequested}\n\n` +
    `RESPOND ONLY WITH THIS JSON SHAPE:\n${responseSchema}`;

  const messages = [{ role: "user", content: userMessage }];

  let claudeBody;
  try {
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: claude-sonnet-5,
        max_tokens: 1000,
        system: systemPrompt,
        messages,
      }),
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      return res.status(502).json({
        error: "Claude API unreachable",
        detail: `HTTP ${claudeResponse.status}: ${errText}`,
      });
    }

    claudeBody = await claudeResponse.json();
  } catch (error) {
    console.error("[WebTMA SERVER] Claude fetch failed:", error);
    return res.status(502).json({
      error: "Claude API unreachable",
      detail: error.message,
    });
  }

  const rawText = claudeBody?.content?.[0]?.text ?? "";
  const cleanedText = stripMarkdownFences(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleanedText);
  } catch (error) {
    console.error("[WebTMA SERVER] JSON parse failed:", error, "raw:", cleanedText);
    return res.status(502).json({
      error: "Claude returned unparseable JSON",
      raw: cleanedText,
    });
  }

  if (
    !isPlainObject(parsed) ||
    !Array.isArray(parsed.suggestions) ||
    typeof parsed.noMatchFound !== "boolean"
  ) {
    console.error("[WebTMA SERVER] Schema check failed:", parsed);
    return res.status(502).json({
      error: "Claude response failed schema check",
      raw: parsed,
    });
  }

  const validSuggestions = [];
  const allValidationErrors = [];

  for (const suggestion of parsed.suggestions) {
    const errors = validateSuggestion(suggestion);
    if (errors.length === 0) {
      validSuggestions.push(suggestion);
      continue;
    }

    const suggestionLabel =
      isPlainObject(suggestion) && typeof suggestion.taskDescription === "string"
        ? suggestion.taskDescription
        : "<unknown>";

    errors.forEach((validationError) => {
      console.log(
        `[WebTMA SERVER] validation dropped suggestion: ${suggestionLabel} - ${validationError}`
      );
    });
    allValidationErrors.push(...errors);
  }

  const noMatchFound = parsed.noMatchFound === true || validSuggestions.length === 0;
  const lowConfidenceWarning = noMatchFound ? false : parsed.lowConfidenceWarning === true;
  const suggestionsReturned = noMatchFound ? [] : validSuggestions;

  const auditEntry = {
    timestamp,
    actionRequested,
    suggestionsReturned: suggestionsReturned.map((suggestion) => suggestion.taskDescription),
    validationErrors: allValidationErrors,
    appliedSuggestion: null,
  };
  appendAuditEntry(auditEntry);

  const elapsed = Date.now() - startTime;
  console.log(
    `[WebTMA SERVER] response - ${suggestionsReturned.length} suggestions - ${elapsed}ms`
  );

  return res.json({
    suggestions: suggestionsReturned,
    noMatchFound,
    lowConfidenceWarning,
    auditTimestamp: timestamp,
  });
});

app.post("/api/audit/applied", async (req, res) => {
  const auditTimestamp = req.body?.auditTimestamp ?? req.body?.timestamp;
  const { appliedSuggestion } = req.body ?? {};

  if (!auditTimestamp || typeof auditTimestamp !== "string") {
    return res.status(400).json({ error: "auditTimestamp is required and must be a string" });
  }

  if (!appliedSuggestion || typeof appliedSuggestion !== "string") {
    return res.status(400).json({ error: "appliedSuggestion is required and must be a string" });
  }

  let lines;
  try {
    const raw = fs.readFileSync(AUDIT_LOG_PATH, "utf8");
    lines = raw.split("\n").filter((line) => line.trim() !== "");
  } catch (error) {
    console.error("[WebTMA SERVER] Failed to read audit.log:", error);
    return res.status(500).json({ error: "Could not read audit log", detail: error.message });
  }

  let matched = false;
  const updatedLines = lines.map((line) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }

    if (entry.timestamp === auditTimestamp) {
      matched = true;
      return JSON.stringify({ ...entry, appliedSuggestion });
    }

    return line;
  });

  if (!matched) {
    return res.status(404).json({ error: "audit entry not found" });
  }

  try {
    fs.writeFileSync(AUDIT_LOG_PATH, updatedLines.join("\n") + "\n", "utf8");
  } catch (error) {
    console.error("[WebTMA SERVER] Failed to write audit.log:", error);
    return res.status(500).json({ error: "Could not write audit log", detail: error.message });
  }

  return res.json({ ok: true });
});

app.get("/api/building-search", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const q = (req.query.q || "").trim().toUpperCase();
    console.log(`[WebTMA SERVER] building-search hit — q: ${q}`);
    if (q.length < 2) return res.json([]);

    if (buildingsByCode[q]) {
      return res.json([buildingsByCode[q]]);
    }

    const results = buildingsArray
      .filter(b => {
        const nameMatch = b.name && b.name.toUpperCase().includes(q);
        const codeMatch = b.bldgCode && b.bldgCode.toUpperCase().includes(q);
        return nameMatch || codeMatch;
      })
      .slice(0, 8)
      .map(b => ({
        name: b.name,
        bldgCode: b.bldgCode,
        rateSchedule: b.rateSchedule,
        sector: b.sector
      }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("[WebTMA SERVER] Listening on http://localhost:3000");
});
