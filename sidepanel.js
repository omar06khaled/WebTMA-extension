/**
 * sidepanel.js - WebTMA Assistant side panel logic
 *
 * DOM elements expected in sidepanel.html:
 *   #action-text   <textarea>  - mirrors the Action Requested field
 *   #suggestions   <div>       - card container
 *   #status-bar    <p|span>    - status / error line
 *   #btn-apply     <button>    - Apply selected suggestion
 */

const actionTextarea = document.getElementById("action-text");
const suggestionsDiv = document.getElementById("suggestions");
const statusBar = document.getElementById("status-bar");
const btnApply = document.getElementById("btn-apply");
const modeToggle = document.getElementById("mode-toggle");
const btnSuggest = document.getElementById("btn-suggest");
const labelAuto = document.getElementById("label-auto");
const labelManual = document.getElementById("label-manual");
const actionLabel = document.getElementById("action-label");
const BUILD_MARKER = "sidepanel-build-2026-04-13-1426";

window.__WEBTMA_SIDEPANEL_BUILD__ = BUILD_MARKER;
document.documentElement.dataset.webtmaBuild = BUILD_MARKER;
console.log(`[WebTMA SP] loaded ${BUILD_MARKER}`);

let manualMode = false;

/** @type {object|null} */
let selectedSuggestion = null;

/** @type {{ key: string, trade: string }|null} */
let selectedCampus = null;

/** @type {string|null} */
let currentAuditTimestamp = null;

/** @type {chrome.runtime.Port | null} */
let port = null;

/** @type {"idle"|"loading"|"results"|"no-match"|"error"} */
let state = "idle";

const STATE_LABELS = {
  idle: "Ready",
  loading: "Fetching suggestions...",
  results: "Suggestions ready - select one and click Apply",
  "no-match": "No match found - please select manually",
  error: "",
};

/** Campus key -> friendly display name. */
const CAMPUS_LABELS = {
  dtpc: "Downtown Phoenix",
  poly: "Polytechnic",
  tempe: "Tempe",
  west: "West",
  rfmtDtpc: "RFMT Downtown",
  rfmtPoly: "RFMT Poly",
  rfmtTmpe: "RFMT Tempe",
  rfmtWest: "RFMT West",
};

function updateModeUI() {
  if (manualMode) {
    actionTextarea.removeAttribute("readonly");
    actionLabel.textContent = "Manual Input - Action Requested";
    actionTextarea.placeholder = "Paste or type Action Requested here...";
    btnSuggest.style.display = "block";
    labelAuto.classList.remove("active");
    labelManual.classList.add("active");
  } else {
    actionTextarea.setAttribute("readonly", "");
    actionLabel.textContent = "Detected - Action Requested";
    actionTextarea.placeholder = "Waiting for WebTMA form...";
    btnSuggest.style.display = "none";
    labelAuto.classList.add("active");
    labelManual.classList.remove("active");
  }
}

function resetSelection() {
  selectedSuggestion = null;
  selectedCampus = null;
  btnApply.disabled = true;
  suggestionsDiv.querySelectorAll(".card").forEach((card) => card.classList.remove("selected"));
  suggestionsDiv.querySelectorAll(".campus-row").forEach((row) => row.classList.remove("campus-selected"));
}

function renderEmptyState(title, body) {
  const emptyState = document.createElement("div");
  emptyState.className = "empty-state";

  const titleEl = document.createElement("span");
  titleEl.className = "empty-state__title";
  titleEl.textContent = title;

  const bodyEl = document.createElement("div");
  bodyEl.className = "empty-state__body";
  bodyEl.textContent = body;

  emptyState.appendChild(titleEl);
  emptyState.appendChild(bodyEl);
  suggestionsDiv.appendChild(emptyState);
}

function setState(newState, errorMessage) {
  state = newState;

  if (newState === "loading" || newState === "no-match" || newState === "error") {
    resetSelection();
  }

  renderState(errorMessage);
}

function renderState(errorMessage) {
  document.body.dataset.state = state;

  if (state === "error") {
    statusBar.textContent = errorMessage ?? "An unknown error occurred.";
  } else {
    statusBar.textContent = STATE_LABELS[state] ?? "";
  }
}

function registerPort(portInstance) {
  port = portInstance;

  portInstance.onMessage.addListener((message) => {
    if (message.type === "ACTION_REQUESTED_CHANGED") {
      if (manualMode) return;

      const actionText = message.payload?.actionRequested ?? "";
      actionTextarea.value = actionText;

      if (actionText.trim().length < 3) {
        currentAuditTimestamp = null;
        suggestionsDiv.innerHTML = "";
        setState("idle");
        return;
      }

      setState("loading");
      fetchSuggestions(actionText);
      return;
    }

    console.log(`[WebTMA SP] unknown message type: ${message.type}`);
  });

  portInstance.onDisconnect.addListener(() => {
    if (port !== portInstance) return;

    currentAuditTimestamp = null;
    port = null;
    setState("error", "Lost connection to extension - reopen the side panel");
  });
}

function connectPort() {
  try {
    registerPort(chrome.runtime.connect({ name: "webtma-sidepanel" }));
    return true;
  } catch (error) {
    console.error(`[WebTMA SP] port connect failed: ${error.message}`);
    port = null;
    return false;
  }
}

function ensurePortConnected() {
  if (port) return true;
  return connectPort();
}

async function postAppliedAudit(auditTimestamp, appliedSuggestion) {
  if (!auditTimestamp || !appliedSuggestion) return;

  try {
    const response = await fetch("http://localhost:3000/api/audit/applied", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auditTimestamp,
        appliedSuggestion,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "<unreadable>");
      console.error(`[WebTMA SP] audit update failed: HTTP ${response.status} ${detail}`);
    }
  } catch (error) {
    console.error(`[WebTMA SP] audit update failed: ${error.message}`);
  }
}

async function fetchSuggestions(actionText) {
  const trimmedText = actionText.trim();
  if (trimmedText.length < 3) {
    currentAuditTimestamp = null;
    suggestionsDiv.innerHTML = "";
    setState("idle");
    return;
  }

  currentAuditTimestamp = null;

  try {
    const response = await fetch("http://localhost:3000/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionRequested: trimmedText }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      const raw = await response.text().catch(() => "<unreadable>");
      throw new Error(`Backend returned unparseable data: ${raw}`);
    }

    if (!response.ok) {
      const detail = data?.detail || data?.error || `HTTP ${response.status}`;
      const statusError = new Error(detail);
      statusError.userMessage = detail;
      throw statusError;
    }

    if (
      !data ||
      !Array.isArray(data.suggestions) ||
      (data.auditTimestamp !== undefined && typeof data.auditTimestamp !== "string")
    ) {
      console.error(`[WebTMA SP] malformed response: ${JSON.stringify(data)}`);
      setState("error", "Backend returned unexpected data shape - check server logs");
      return;
    }

    currentAuditTimestamp = data.auditTimestamp ?? null;

    if (data.noMatchFound === true) {
      renderSuggestions([], { nextState: "no-match" });
      return;
    }

    renderSuggestions(data.suggestions, {
      lowConfidence: data.lowConfidenceWarning === true,
      nextState: "results",
    });
  } catch (error) {
    console.error(`[WebTMA SP] fetch failed: ${error.message}`);
    currentAuditTimestamp = null;
    suggestionsDiv.innerHTML = "";
    setState(
      "error",
      error.userMessage || "Backend unreachable - is the server running?"
    );
  }
}

function renderSuggestions(suggestions, options = {}) {
  const { lowConfidence = false, nextState = "results" } = options;

  resetSelection();
  suggestionsDiv.innerHTML = "";

  if (lowConfidence && suggestions.length > 0) {
    const banner = document.createElement("div");
    banner.className = "warning-banner";
    banner.textContent = "Low confidence results - please verify before applying";
    suggestionsDiv.appendChild(banner);
  }

  for (const suggestion of suggestions) {
    suggestionsDiv.appendChild(buildCard(suggestion));
  }

  if (suggestions.length === 0) {
    if (nextState === "no-match") {
      renderEmptyState(
        "No matching suggestion found",
        "Try different wording, add more detail, or choose the work-order fields manually."
      );
    } else if (nextState === "idle") {
      renderEmptyState(
        "Waiting for input",
        "Open a WebTMA work order in Auto mode or type an action request in Manual mode."
      );
    } else {
      renderEmptyState(
        "No suggestions available",
        "No suggestion cards were returned for this request."
      );
    }
  }

  setState(nextState);
}

function buildCard(suggestion) {
  const card = document.createElement("div");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "card-header";

  const descEl = document.createElement("span");
  descEl.className = "card-task-description";
  descEl.textContent = suggestion.taskDescription;

  const codeEl = document.createElement("span");
  codeEl.className = "card-task-code";
  codeEl.textContent = `#${suggestion.taskCode}`;

  header.appendChild(descEl);
  header.appendChild(codeEl);
  card.appendChild(header);

  const categoryEl = document.createElement("div");
  categoryEl.className = "card-category";
  categoryEl.textContent = suggestion.category;
  card.appendChild(categoryEl);

  const badge = document.createElement("span");
  badge.className = "card-confidence-badge";
  if (suggestion.confidence >= 0.8) {
    badge.classList.add("confidence-high");
    badge.textContent = "High confidence";
  } else {
    badge.classList.add("confidence-low");
    badge.textContent = "Low confidence - verify";
  }
  card.appendChild(badge);

  if (suggestion.tradeOptions && typeof suggestion.tradeOptions === "object") {
    const table = document.createElement("table");
    table.className = "card-trade-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["Campus", "Trade"].forEach((columnLabel) => {
      const th = document.createElement("th");
      th.textContent = columnLabel;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const [key, value] of Object.entries(suggestion.tradeOptions)) {
      const row = document.createElement("tr");
      row.className = "campus-row";

      const campusTd = document.createElement("td");
      campusTd.textContent = CAMPUS_LABELS[key] ?? key;

      const tradeTd = document.createElement("td");
      tradeTd.textContent = String(value);

      row.appendChild(campusTd);
      row.appendChild(tradeTd);
      tbody.appendChild(row);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        suggestionsDiv.querySelectorAll(".card").forEach((c) => c.classList.remove("selected"));
        suggestionsDiv.querySelectorAll(".campus-row").forEach((r) => r.classList.remove("campus-selected"));
        card.classList.add("selected");
        row.classList.add("campus-selected");
        selectedSuggestion = suggestion;
        selectedCampus = { key, trade: String(value) };
        btnApply.disabled = false;
      });
    }
    table.appendChild(tbody);
    card.appendChild(table);
  }

  if (suggestion.notes != null) {
    const notesEl = document.createElement("div");
    notesEl.className = "card-notes";
    notesEl.textContent = suggestion.notes;
    card.appendChild(notesEl);
  }

  card.addEventListener("click", () => selectCard(suggestion, card));

  return card;
}

function selectCard(suggestion, cardEl) {
  selectedSuggestion = suggestion;
  selectedCampus = null;

  suggestionsDiv.querySelectorAll(".card").forEach((card) => card.classList.remove("selected"));
  suggestionsDiv.querySelectorAll(".campus-row").forEach((row) => row.classList.remove("campus-selected"));
  cardEl.classList.add("selected");

  btnApply.disabled = true; // campus row must also be selected
}

modeToggle.addEventListener("change", () => {
  manualMode = modeToggle.checked;
  updateModeUI();
});

btnSuggest.addEventListener("click", () => {
  const text = actionTextarea.value.trim();
  if (!text) return;
  setState("loading");
  fetchSuggestions(text);
});

actionTextarea.addEventListener("keydown", (event) => {
  if (manualMode && event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    const text = actionTextarea.value.trim();
    if (!text) return;
    setState("loading");
    fetchSuggestions(text);
  }
});

updateModeUI();
connectPort();

btnApply.addEventListener("click", async () => {
  if (selectedSuggestion === null) {
    console.warn("[WebTMA SP] Apply clicked with no selected suggestion");
    return;
  }

  const appliedSuggestion = selectedSuggestion.taskDescription;
  const auditTimestamp = currentAuditTimestamp;

  try {
    await chrome.runtime.sendMessage({
      type: "FILL_FIELDS",
      payload: {
        taskCode: selectedSuggestion.taskCode,
        taskDescription: selectedSuggestion.taskDescription,
        campusKey: selectedCampus?.key ?? null,
        trade: selectedCampus?.trade ?? null,
      },
    });
  } catch (error) {
    console.error(`[WebTMA SP] sendMessage failed: ${error.message}`);
    setState("error", "Extension connection is unavailable - reopen the side panel");
    return;
  }

  btnApply.disabled = true;
  statusBar.textContent = "Applied task fields - verify the form and choose trade manually";

  await postAppliedAudit(auditTimestamp, appliedSuggestion);
});
