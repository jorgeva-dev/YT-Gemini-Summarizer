// Background Service Worker (Manifest V3)
import { getDefaultActions } from '../config/default-actions.js';

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn('Side Panel behavior setting not supported:', error));
  }

  // Siembra de acciones por defecto (sólo si no existen)
  const data = await chrome.storage.local.get('acciones');
  if (!data.acciones) {
    const defaultActions = getDefaultActions();
    await chrome.storage.local.set({ acciones: defaultActions });
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

        // La entrada NO se borra aquí. Gemini puede redirigir (aceptar
        // condiciones, elegir cuenta, /app -> /u/1/app), y cada redirección
        // crea un documento nuevo que vuelve a ejecutar el content script. Si
        // se consumiera en la primera lectura, la redirección se llevaría por
        // delante el texto y la pestaña se quedaría vacía sin explicación.
        // Se elimina en PROMPT_CONSUMED, cuando el pegado ya ha ocurrido.

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

  // El content script confirma que el texto ya está en el editor de Gemini.
  // Sólo entonces se descarta, para que una redirección previa no lo pierda.
  if (request.action === 'PROMPT_CONSUMED') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false });
          return;
        }

        const data = await chrome.storage.local.get('pendingPrompts');
        const pendingPrompts = data.pendingPrompts || {};
        delete pendingPrompts[tabId];
        await chrome.storage.local.set({ pendingPrompts });

        sendResponse({ ok: true });
      } catch (err) {
        console.error('[service-worker] Error al procesar PROMPT_CONSUMED:', err);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
});
