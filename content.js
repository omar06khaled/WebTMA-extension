/**
 * content.js - WebTMA Assistant
 *
 * Responsibilities:
 *  1. Detect when the page contains a WebTMA work-order form.
 *  2. Watch the "Action Requested" textarea for changes (debounced).
 *  3. Send the current text to the side panel via chrome.runtime.sendMessage.
 *  4. Listen for "fill" commands from the side panel and write values back
 *     into the Task Code, Task Description, and Trade Description fields.
 */

console.log("[WebTMA CS] content script loaded on:", location.href);

/**
 * Returns the first element matched by any selector in the list,
 * searching the main document and every accessible iframe.
 * @param {...string} selectors
 * @returns {Element|null}
 */
function findField(...selectors) {
  const docs = [document];
  document.querySelectorAll("iframe").forEach((frame) => {
    try {
      if (frame.contentDocument) docs.push(frame.contentDocument);
    } catch {
      // Ignore cross-origin iframes.
    }
  });

  for (const doc of docs) {
    for (const selector of selectors) {
      const element = doc.querySelector(selector);
      if (element) return element;
    }
  }

  return null;
}

const SELECTORS = {
  actionRequested: [
    "textarea[name='ActionRequired']",
    "textarea[id*='ActionRequired']",
    "textarea[name*='ActionRequest']",
    "textarea[id*='ActionRequest']",
    "#txtActionRequired",
    "#txtProblemDescription",
  ],
  taskCode: [
    "input[name='TaskCode']",
    "input[id*='TaskCode']",
    "#txtTaskCode",
  ],
  taskDescription: [
    "input[name='TaskDescription']",
    "input[id*='TaskDescription']",
    "#txtTaskDescription",
    "span[id*='TaskDescription']",
  ],
  tradeDescription: [
    "select[name='TradeCode']",
    "select[id*='TradeCode']",
    "input[name='TradeCode']",
    "input[id*='TradeCode']",
    "#ddlTrade",
    "#txtTrade",
  ],
};

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let lastSentText = "";

function readAndSend() {
  const element = findField(...SELECTORS.actionRequested);
  if (!element) return;

  const text = (element.value || element.innerText || "").trim();
  if (text.length < 3 || text === lastSentText) return;

  lastSentText = text;

  chrome.runtime.sendMessage({
    type: "ACTION_REQUESTED_CHANGED",
    payload: { actionRequested: text },
  });
}

const debouncedReadAndSend = debounce(readAndSend, 600);

function attachListeners(field) {
  field.addEventListener("input", debouncedReadAndSend);
  field.addEventListener("change", debouncedReadAndSend);
  debouncedReadAndSend();
}

function waitForField() {
  const field = findField(...SELECTORS.actionRequested);
  if (field) {
    console.log("[WebTMA CS] found action field immediately:", field);
    attachListeners(field);
    return;
  }

  let attempts = 0;
  const interval = setInterval(() => {
    attempts += 1;
    const candidate = findField(...SELECTORS.actionRequested);

    if (candidate) {
      clearInterval(interval);
      console.log("[WebTMA CS] found action field after", attempts, "attempts:", candidate);
      attachListeners(candidate);
      return;
    }

    if (attempts > 50) {
      clearInterval(interval);
      console.warn("[WebTMA CS] gave up looking for action field after 50 attempts");
      return;
    }

    console.log("[WebTMA CS] field not found yet, attempt:", attempts);
  }, 200);
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastSentText = "";
    waitForField();
  }
}).observe(document.body, { subtree: true, childList: true });

waitForField();

function setFieldValue(el, value) {
  if (!el) return;

  if (el.tagName === "SELECT") {
    if (typeof value !== "string") {
      console.warn("[WebTMA CS] Ignoring non-string trade value for select field");
      return;
    }

    const option = Array.from(el.options).find(
      (candidate) =>
        candidate.value.toLowerCase() === value.toLowerCase() ||
        candidate.text.toLowerCase() === value.toLowerCase()
    );

    if (option) el.value = option.value;
  } else if ("value" in el) {
    el.value = value;
  } else {
    el.textContent = value;
  }

  ["input", "change", "blur"].forEach((eventName) => {
    el.dispatchEvent(new Event(eventName, { bubbles: true }));
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "FILL_FIELDS") return;

  const { taskCode, taskDescription, tradeDescription } = message.payload ?? {};

  if (taskCode !== undefined) {
    setFieldValue(findField(...SELECTORS.taskCode), String(taskCode));
  }

  if (taskDescription !== undefined) {
    setFieldValue(findField(...SELECTORS.taskDescription), String(taskDescription));
  }

  if (typeof tradeDescription === "string") {
    setFieldValue(findField(...SELECTORS.tradeDescription), tradeDescription);
  } else if (tradeDescription !== undefined) {
    console.warn("[WebTMA CS] Ignoring non-string tradeDescription payload");
  }
});
