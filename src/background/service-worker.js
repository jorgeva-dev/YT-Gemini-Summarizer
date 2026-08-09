// Background Service Worker (Manifest V3)

// Configure Side Panel to open automatically when clicking the extension toolbar icon
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn('Side Panel behavior setting not supported:', error));
  }
});

// Listener for messages from sidepanel or content scripts if message routing is required
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'GET_PENDING_PROMPT') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        if (!tabId) {
          sendResponse({ prompt: null });
          return;
        }

        const data = await chrome.storage.local.get('pendingPrompts');
        const pendingPrompts = data.pendingPrompts || {};

        const prompt = pendingPrompts[tabId] || null;

        // Eliminar la entrada consumida de esta pestaña
        delete pendingPrompts[tabId];

        // Purgar entradas de más de 2 minutos y de pestañas cerradas
        const now = Date.now();
        const tabIds = Object.keys(pendingPrompts);
        for (const id of tabIds) {
          const entry = pendingPrompts[id];
          if (!entry?.createdAt || now - entry.createdAt > 2 * 60 * 1000) {
            delete pendingPrompts[id];
            continue;
          }
          try {
            await chrome.tabs.get(Number(id));
          } catch (e) {
            delete pendingPrompts[id];
          }
        }

        await chrome.storage.local.set({ pendingPrompts });

        // Verificar si el prompt expiró (> 2 minutos)
        if (prompt && prompt.createdAt && now - prompt.createdAt > 2 * 60 * 1000) {
          sendResponse({ prompt: null });
          return;
        }

        sendResponse({ prompt });
      } catch (err) {
        console.error('[service-worker] Error al procesar GET_PENDING_PROMPT:', err);
        sendResponse({ prompt: null });
      }
    })();
    return true;
  }
});
