// MV3 service worker - assume this file re-executes on every wake.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error("[WebTMA BG] setPanelBehavior failed:", err.message);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.error("[WebTMA BG] setPanelBehavior (onInstalled) failed:", err.message);
  });
});

/** @type {chrome.runtime.Port | null} */
let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "webtma-sidepanel") return;

  sidePanelPort = port;
  console.log("[WebTMA BG] Side panel connected");

  chrome.storage.session.get("lastActionRequested", (result) => {
    if (result.lastActionRequested === undefined || sidePanelPort !== port) return;

    try {
      port.postMessage({
        type: "ACTION_REQUESTED_CHANGED",
        payload: result.lastActionRequested,
      });
      console.log("[WebTMA BG] OUT ACTION_REQUESTED_CHANGED - tab: none (hydration)");
    } catch (err) {
      console.error("[WebTMA BG] hydration postMessage failed:", err.message);
    }
  });

  port.onDisconnect.addListener(() => {
    if (sidePanelPort === port) {
      sidePanelPort = null;
    }
    console.log("[WebTMA BG] Side panel disconnected");
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "FILL_FIELDS") {
    relayFillFields(message);
    return;
  }

  if (message.type !== "ACTION_REQUESTED_CHANGED") return;

  const tabId = sender.tab?.id ?? "none";
  console.log(`[WebTMA BG] IN ACTION_REQUESTED_CHANGED - tab: ${tabId}`);

  if (!isWebtmaUrl(sender.tab?.url)) {
    console.warn(
      "[WebTMA BG] ACTION_REQUESTED_CHANGED ignored - sender is not *.webtma.net:",
      sender.tab?.url
    );
    return;
  }

  chrome.storage.session.set({ lastActionRequested: message.payload }, () => {
    if (chrome.runtime.lastError) {
      console.error("[WebTMA BG] storage.session.set failed:", chrome.runtime.lastError.message);
    }
  });

  if (sidePanelPort !== null) {
    try {
      sidePanelPort.postMessage({
        type: "ACTION_REQUESTED_CHANGED",
        payload: message.payload,
      });
      console.log(`[WebTMA BG] OUT ACTION_REQUESTED_CHANGED - tab: ${tabId}`);
    } catch (err) {
      console.error("[WebTMA BG] ACTION_REQUESTED_CHANGED relay failed:", err.message);
    }
  } else {
    console.log("[WebTMA BG] Side panel not open - message persisted in session storage");
  }
});

function relayFillFields(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const tabId = tab?.id ?? "none";

    console.log(`[WebTMA BG] IN FILL_FIELDS - tab: ${tabId}`);

    if (!tab || !isWebtmaUrl(tab.url)) {
      console.warn("[WebTMA BG] FILL_FIELDS ignored - active tab is not *.webtma.net:", tab?.url);
      return;
    }

    try {
      chrome.tabs.sendMessage(tab.id, message);
      console.log(`[WebTMA BG] OUT FILL_FIELDS - tab: ${tabId}`);
    } catch (err) {
      console.error("[WebTMA BG] FILL_FIELDS relay failed:", err.message);
    }
  });
}

/**
 * Returns true if the URL belongs to a *.webtma.net origin.
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isWebtmaUrl(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "webtma.net" || hostname.endsWith(".webtma.net");
  } catch {
    return false;
  }
}
