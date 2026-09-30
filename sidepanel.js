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

const SERVER_BASE_URL = "https://webtma-extension.onrender.com";

let manualMode = false;

/** @type {object|null} */
let selectedSuggestion = null;
let selectedBuilding = null;
let buildingSearchTimeout = null;

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
    const response = await fetch(`${SERVER_BASE_URL}/api/audit/applied`, {
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
    const response = await fetch(`${SERVER_BASE_URL}/api/suggest`, {
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
      suggestionsDiv.innerHTML = "";
      renderEmptyState("Couldn't get suggestions", "Backend returned unexpected data shape - check server logs");
      setState("error", "Backend returned unexpected data shape - check server logs");
      return;
    }

    currentAuditTimestamp = data.auditTimestamp ?? null;

    let layer2 = null;
    if (data.layer2 !== undefined) {
      if (isValidLayer2(data.layer2)) {
        layer2 = data.layer2;
      } else {
        console.error(`[WebTMA SP] malformed layer2 in response, not shown: ${JSON.stringify(data.layer2)}`);
      }
    }

    if (data.noMatchFound === true) {
      renderSuggestions([], { nextState: "no-match", layer2 });
      return;
    }

    renderSuggestions(data.suggestions, {
      lowConfidence: data.lowConfidenceWarning === true,
      nextState: "results",
      layer2,
    });
  } catch (error) {
    console.error(`[WebTMA SP] fetch failed: ${error.message}`);
    currentAuditTimestamp = null;
    suggestionsDiv.innerHTML = "";
    const message = error.userMessage || "Backend unreachable - is the server running?";
    renderEmptyState("Couldn't get suggestions", message);
    setState("error", message);
  }
}

function renderSuggestions(suggestions, options = {}) {
  const { lowConfidence = false, nextState = "results", layer2 = null } = options;

  resetSelection();
  suggestionsDiv.innerHTML = "";

  if (lowConfidence && suggestions.length > 0) {
    const banner = document.createElement("div");
    banner.className = "warning-banner";
    banner.textContent = "Low confidence results - please verify before applying";
    suggestionsDiv.appendChild(banner);
  }

  for (const suggestion of suggestions) {
    const card = buildCard(suggestion);
    suggestionsDiv.appendChild(card);
    initBuildingSearch(card);
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

  if (layer2) {
    const layer2Card = buildLayer2Card(layer2);
    suggestionsDiv.appendChild(layer2Card);
    if (layer2.suggestion) initBuildingSearch(layer2Card);
  }

  setState(nextState);
}

function isValidLayer2(layer2) {
  return (
    layer2 !== null &&
    typeof layer2 === "object" &&
    typeof layer2.guidance === "string" &&
    Array.isArray(layer2.citedSheets) &&
    layer2.citedSheets.every((sheet) => typeof sheet === "string") &&
    (layer2.suggestion === null || (typeof layer2.suggestion === "object" && !Array.isArray(layer2.suggestion)))
  );
}

/**
 * Layer 2 card: desk-manual guidance, kept visually separate from Layer 1 cards.
 * With a validated suggestion it reuses buildCard(), so Apply is only enabled by
 * clicking a campus row, same as Layer 1. Without one, the card has no Apply path.
 */
function buildLayer2Card(layer2) {
  const card = layer2.suggestion ? buildCard(layer2.suggestion) : document.createElement("div");
  card.classList.add("card", "layer2-card");
  card.style.borderStyle = "dashed";
  if (!layer2.suggestion) card.style.cursor = "default";

  const section = document.createElement("div");
  section.className = "layer2-section";
  section.style.cssText = "margin-bottom:10px;";

  const label = document.createElement("div");
  label.className = "layer2-label";
  label.style.cssText = "font-size:12px; font-weight:700; color:#7a5800; margin-bottom:6px;";
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "\u{1F4D6} ";
  label.appendChild(icon);
  label.appendChild(document.createTextNode("Layer 2: from desk manual (verify)"));

  const guidance = document.createElement("div");
  guidance.className = "layer2-guidance";
  guidance.style.cssText = "font-size:13px; color:#1a1a1a; line-height:1.45; margin-bottom:6px;";
  guidance.textContent = layer2.guidance;

  const source = document.createElement("div");
  source.className = "layer2-source";
  source.style.cssText = "font-size:11px; color:#666;";
  source.textContent = `Source: ${layer2.citedSheets.length > 0 ? layer2.citedSheets.join(", ") : "no sheet cited"}`;

  section.appendChild(label);
  section.appendChild(guidance);
  section.appendChild(source);
  card.prepend(section);

  return card;
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

  const buildingSection = document.createElement("div");
  buildingSection.className = "building-search-section";
  buildingSection.style.cssText = "margin-bottom:14px;";
  buildingSection.innerHTML = `
    <label style="font-size:11px; font-weight:600; color:#666; text-transform:uppercase; letter-spacing:0.5px; display:block; margin-bottom:6px;">Building / Location</label>
    <input
      class="building-search-input"
      type="text"
      placeholder="Search by building name or code..."
      style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #ddd; border-radius:6px; font-size:13px; outline:none;"
    />
    <div class="building-search-results" style="display:none; border:1px solid #ddd; border-radius:6px; margin-top:4px; background:#fff; max-height:200px; overflow-y:auto;"></div>
    <div class="building-selected" style="display:none; margin-top:8px; padding:8px 10px; background:#f5f5f5; border-radius:6px; font-size:13px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <span class="building-selected-name" style="font-weight:600; color:#1a1a1a;"></span>
          <span class="building-selected-code" style="color:#888; margin-left:6px; font-size:12px;"></span>
        </div>
        <button class="building-clear-btn" style="background:none; border:none; cursor:pointer; color:#888; font-size:16px; padding:0 4px;">×</button>
      </div>
      <div style="margin-top:4px; display:flex; gap:12px;">
        <span style="font-size:11px; color:#666;">Rate Schedule: <strong class="building-rate-schedule" style="color:#1a1a1a;"></strong></span>
        <span style="font-size:11px; color:#666;">Sector: <strong class="building-sector" style="color:#1a1a1a;"></strong></span>
      </div>
    </div>
  `;
  card.appendChild(buildingSection);

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

function initBuildingSearch(card) {
  const section = card.querySelector(".building-search-section");
  if (!section) return;

  const input = section.querySelector(".building-search-input");
  const results = section.querySelector(".building-search-results");
  const selectedDiv = section.querySelector(".building-selected");

  input.addEventListener("input", () => {
    clearTimeout(buildingSearchTimeout);
    const q = input.value.trim();
    if (q.length < 2) {
      results.style.display = "none";
      results.innerHTML = "";
      return;
    }
    buildingSearchTimeout = setTimeout(() => fetchBuildingResults(q, section), 250);
  });

  section.querySelector(".building-clear-btn").addEventListener("click", () => {
    selectedBuilding = null;
    input.value = "";
    selectedDiv.style.display = "none";
    results.style.display = "none";
    results.innerHTML = "";
    input.style.display = "block";
  });
}

async function fetchBuildingResults(q, section) {
  const results = section.querySelector(".building-search-results");
  try {
    const res = await fetch(`${SERVER_BASE_URL}/api/building-search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.length === 0) {
      results.style.display = "none";
      return;
    }
    results.innerHTML = data.map(b => `
      <div class="building-result-item"
        data-code="${b.bldgCode || ""}"
        data-name="${b.name}"
        data-rs="${b.rateSchedule || ""}"
        data-sector="${b.sector || ""}">
        ${b.name}<span class="building-result-code">${b.bldgCode || ""}</span>
      </div>
    `).join("");
    results.style.display = "block";

    results.querySelectorAll(".building-result-item").forEach(item => {
      item.addEventListener("click", () => {
        selectBuilding({
          name: item.dataset.name,
          bldgCode: item.dataset.code,
          rateSchedule: item.dataset.rs || null,
          sector: item.dataset.sector
        }, section);
      });
    });
  } catch (err) {
    console.error("[WebTMA SP] Building search error:", err);
  }
}

function selectBuilding(building, section) {
  selectedBuilding = building;
  const input = section.querySelector(".building-search-input");
  const results = section.querySelector(".building-search-results");
  const selectedDiv = section.querySelector(".building-selected");

  input.style.display = "none";
  results.style.display = "none";

  section.querySelector(".building-selected-name").textContent = building.name;
  section.querySelector(".building-selected-code").textContent = building.bldgCode ? `#${building.bldgCode}` : "";
  section.querySelector(".building-rate-schedule").textContent = building.rateSchedule || "N/A";
  section.querySelector(".building-sector").textContent = building.sector || "N/A";
  selectedDiv.style.display = "block";
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
