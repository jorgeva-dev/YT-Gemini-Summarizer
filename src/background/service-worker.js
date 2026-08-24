// Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn('Side Panel behavior setting not supported:', error));
  }

  // Siembra de acciones por defecto
  const data = await chrome.storage.local.get('acciones');
  if (!data.acciones) {
    const defaultActions = [
      {
        id: crypto.randomUUID(),
        nombre: 'Resumen corto',
        icono: '⚡',
        destino: 'app',
        prompt: 'Por favor, elabora un resumen breve en español de aproximadamente 8 a 10 líneas de la transcripción del siguiente vídeo de YouTube titulado "{{titulo}}".\n\nEscribe el resumen en prosa corrida, en un único bloque de texto sin encabezados, sin viñetas y sin introducciones ni preámbulos. Céntrate únicamente en extraer el contenido esencial del vídeo.\n\n---\n\nTRANSCRIPCIÓN COMPLETA:\n{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Resumen extendido',
        icono: '📋',
        destino: 'app',
        prompt: 'Por favor, analiza la siguiente transcripción del vídeo de YouTube titulado "{{titulo}}" y genera:\n\n1. Un resumen ejecutivo (3-4 frases).\n2. Los 5-7 puntos clave con viñetas explicativas.\n3. Conclusiones o \'takeaways\' accionables.\n\nFormatea todo con Markdown claro utilizando encabezados H2 y H3, y negrita para los conceptos importantes.\n\n---\n\nTRANSCRIPCIÓN COMPLETA:\n{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Preguntar al vídeo',
        icono: '💬',
        destino: 'app',
        prompt: 'Título del vídeo: "{{titulo}}"\n\nTranscripción:\n{{transcripcion}}\n\nConfirma en una sola línea que has leído la transcripción y que estás listo para responder preguntas. No resumas nada todavía ni añadas ninguna otra información.'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Datos y referencias',
        icono: '🔢',
        destino: 'app',
        prompt: 'A partir del vídeo "{{titulo}}" y la siguiente transcripción, extrae únicamente la información verificable que se cite explícitamente: cifras y estadísticas, estudios o fuentes, nombres propios, libros, herramientas y enlaces mencionados.\n\nPreséntalo en una lista, indicando claramente si alguna afirmación importante carece de fuente citada en el vídeo. No incluyas opiniones ni resúmenes.\n\nTranscripción:\n{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Copiar transcripción',
        icono: '📄',
        destino: 'portapapeles',
        prompt: '{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Índice con minutos',
        icono: '🕒',
        destino: 'app',
        prompt: 'A continuación tienes la transcripción del vídeo "{{titulo}}" con marcas de tiempo. Crea un índice de secciones para el vídeo, indicando el minuto de inicio y una frase de descripción para cada sección. Añade además al final de cada ítem del índice un enlace con este formato exacto para que yo pueda hacer clic y saltar a ese momento del vídeo: {{url}}&t=SEGUNDOSs (sustituyendo SEGUNDOS por los segundos totales, por ejemplo &t=125s).\n\nTranscripción:\n{{transcripcion_con_tiempos}}'
      }
    ];
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
