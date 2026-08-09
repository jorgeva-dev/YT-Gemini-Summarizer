/**
 * YouTube Transcript Extraction Service
 *
 * IMPORTANTE: desde 2024 el endpoint `https://www.youtube.com/api/timedtext`
 * responde HTTP 200 con un cuerpo VACÍO cuando la petición no procede de la
 * propia sesión de youtube.com. El `baseUrl` que entrega el reproductor lleva
 * parámetros ligados a la sesión (`pot`, `signature`, `expire`, visitorData),
 * así que descargarlo desde el side panel (origen `chrome-extension://`, sin
 * cookies ni Referer) devuelve 0 bytes aunque el vídeo sí tenga transcripción.
 *
 * Además, desde 2025 YouTube exige un token `pot` (Proof of Origin) que genera
 * el reproductor y que NO viene en el `baseUrl` del playerResponse. Por eso el
 * fetch directo del baseUrl devuelve 0 bytes incluso desde la propia página.
 *
 * TODA la descarga se ejecuta dentro de la pestaña (mundo MAIN) vía
 * chrome.scripting, con estas capas dentro de la página:
 *   1. timedtext con el baseUrl del playerResponse (json3 / xml / srv3)
 *   2. sesión del reproductor: se le fuerza a pedir subtítulos, se captura esa
 *      URL (que sí trae `pot`) y se reutiliza cambiando el idioma  <-- la clave
 *   3. endpoint interno /youtubei/v1/get_transcript (el que usa la UI)
 *   4. scraping del panel "Mostrar transcripción" del DOM
 * Y fuera de la página, como último recurso, el content script y la API
 * youtubei desde la extensión.
 */

/**
 * Extracts YouTube video ID from various YouTube URL formats.
 * @param {string} url
 * @returns {string|null}
 */
export function extractVideoId(url) {
  if (!url) return null;
  const watchMatch = url.match(/[?&]v=([^&]+)/);
  if (watchMatch && watchMatch[1]) return watchMatch[1];

  const shortsMatch = url.match(/\/shorts\/([^/?#]+)/);
  if (shortsMatch && shortsMatch[1]) return shortsMatch[1];

  const shortUrlMatch = url.match(/youtu\.be\/([^/?#]+)/);
  if (shortUrlMatch && shortUrlMatch[1]) return shortUrlMatch[1];

  return null;
}

/**
 * Decodes HTML entities in text content.
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetches and parses timedtext payload (XML or JSON3). Sólo se usa en el
 * último recurso desde la extensión; normalmente devuelve vacío (ver cabecera).
 * @param {string} baseUrl
 * @returns {Promise<string>}
 */
async function fetchAndParseTranscriptText(baseUrl) {
  const response = await fetch(baseUrl);
  if (!response.ok) {
    throw new Error(`Error HTTP ${response.status} al descargar subtítulos.`);
  }

  const rawText = await response.text();
  let fullText = '';

  // Attempt JSON3 parse
  if (rawText.trim().startsWith('{')) {
    try {
      const data = JSON.parse(rawText);
      if (data.events && Array.isArray(data.events)) {
        for (const evt of data.events) {
          if (evt.segs && Array.isArray(evt.segs)) {
            for (const seg of evt.segs) {
              if (seg.utf8) fullText += seg.utf8 + ' ';
            }
          }
        }
      }
    } catch (e) {
      console.warn('[youtube-service] JSON3 parse error:', e);
    }
  }

  // Fallback to XML parse
  if (!fullText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(rawText, 'text/xml');
    const nodes = xmlDoc.getElementsByTagName('text');
    if (nodes && nodes.length > 0) {
      for (let i = 0; i < nodes.length; i++) {
        const decoded = decodeEntities(nodes[i].textContent);
        if (decoded) fullText += decoded + ' ';
      }
    }
  }

  return fullText.replace(/\s+/g, ' ').trim();
}

/**
 * Función auto-contenida que se inyecta en el mundo MAIN de la pestaña.
 * No puede referenciar nada del módulo: se serializa y ejecuta en la página.
 * @returns {Promise<Object>}
 */
async function pageTranscriptExtractor() {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const decode = (s) =>
    clean(
      (s || '')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#10;/g, ' ')
    );

  function getPlayerResponse() {
    const currentVideoId = new URLSearchParams(window.location.search).get('v');

    // 1. Priorizar #movie_player (siempre refleja el vídeo actual tras navegación SPA)
    try {
      const player = document.querySelector('#movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const resp = player.getPlayerResponse();
        if (resp && resp.captions) {
          const respId = resp.videoDetails?.videoId;
          if (!currentVideoId || !respId || respId === currentVideoId) {
            return resp;
          }
        }
      }
    } catch (e) { /* noop */ }

    // 2. Probar window.ytInitialPlayerResponse si coincide el videoId
    try {
      if (window.ytInitialPlayerResponse) {
        const resp = window.ytInitialPlayerResponse;
        const respId = resp.videoDetails?.videoId;
        if (!currentVideoId || !respId || respId === currentVideoId) {
          return resp;
        }
      }
    } catch (e) { /* noop */ }

    // 3. Fallback a cualquier playerResponse de #movie_player o global
    try {
      const player = document.querySelector('#movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const resp = player.getPlayerResponse();
        if (resp) return resp;
      }
    } catch (e) { /* noop */ }

    try {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    } catch (e) { /* noop */ }

    return null;
  }

  function parseTimedText(raw) {
    const text = (raw || '').trim();
    if (!text) return '';

    if (text.startsWith('{')) {
      try {
        const data = JSON.parse(text);
        let out = '';
        for (const evt of data.events || []) {
          for (const seg of evt.segs || []) {
            if (seg.utf8) out += seg.utf8 + ' ';
          }
        }
        return clean(out);
      } catch (e) {
        return '';
      }
    }

    if (text.startsWith('<')) {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      let out = '';
      // srv1 / plain XML: <text start=".." dur="..">
      for (const node of Array.from(doc.getElementsByTagName('text'))) {
        const d = decode(node.textContent);
        if (d) out += d + ' ';
      }
      // srv3: <p><s>..</s></p>
      if (!clean(out)) {
        for (const node of Array.from(doc.getElementsByTagName('p'))) {
          const d = decode(node.textContent);
          if (d) out += d + ' ';
        }
      }
      return clean(out);
    }

    return '';
  }

  /** Descarga el baseUrl probando varios formatos hasta obtener contenido. */
  async function fetchTimedText(baseUrl) {
    const buildUrl = (fmt) => {
      try {
        const u = new URL(baseUrl, location.origin);
        if (fmt) u.searchParams.set('fmt', fmt);
        else u.searchParams.delete('fmt');
        return u.toString();
      } catch (e) {
        return baseUrl;
      }
    };

    for (const url of [buildUrl('json3'), buildUrl(null), buildUrl('srv3')]) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          log.push('timedtext HTTP ' + res.status);
          continue;
        }
        const raw = await res.text();
        const parsed = parseTimedText(raw);
        if (parsed) return parsed;
        log.push('timedtext respuesta vacía (bytes=' + raw.length + ')');
      } catch (e) {
        log.push('timedtext fetch: ' + e.message);
      }
    }
    return '';
  }

  /**
   * Combina la URL capturada al reproductor (que trae los parámetros de sesión:
   * pot, potc, c, cver, xorb/xobt/xovt...) con el idioma de la pista deseada.
   */
  function mergeCaptionUrl(capturedUrl, trackBaseUrl) {
    const merged = new URL(capturedUrl);
    let track = null;
    try {
      track = new URL(trackBaseUrl, location.origin);
    } catch (e) {
      return merged.toString();
    }
    // Sólo se sustituye lo que identifica a la pista; el resto es de sesión.
    for (const key of ['lang', 'kind', 'name', 'tlang', 'variant']) {
      const value = track.searchParams.get(key);
      if (value === null) merged.searchParams.delete(key);
      else merged.searchParams.set(key, value);
    }
    merged.searchParams.set('fmt', 'json3');
    return merged.toString();
  }

  /**
   * Provoca que el reproductor pida los subtítulos y captura esa URL, que sí
   * lleva el token `pot` (Proof of Origin) que YouTube exige desde 2025.
   * Sin él, /api/timedtext responde 200 con 0 bytes aunque haya transcripción.
   *
   * Se activa y se restaura la pista de subtítulos previa del usuario; el
   * cambio es momentáneo. Hay que recorrer varias pistas porque el reproductor
   * no vuelve a pedir por red una que ya tenga cacheada.
   */
  async function capturePlayerCaptionUrl(player, tracklist) {
    const captured = [];
    const record = (url) => {
      const str = String(url || '');
      if (str.includes('/api/timedtext') && str.includes('pot=')) captured.push(str);
    };

    const origFetch = window.fetch;
    const origOpen = XMLHttpRequest.prototype.open;

    window.fetch = function (input) {
      try {
        record(typeof input === 'string' ? input : (input && input.url) || '');
      } catch (e) { /* noop */ }
      return origFetch.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      try { record(url); } catch (e) { /* noop */ }
      return origOpen.apply(this, arguments);
    };

    let previous = null;
    try { previous = player.getOption('captions', 'track'); } catch (e) { /* noop */ }

    try {
      for (const candidate of tracklist) {
        try {
          player.setOption('captions', 'track', candidate);
        } catch (e) {
          continue;
        }
        for (let i = 0; i < 15 && !captured.length; i++) await sleep(150);
        if (captured.length) break;
      }
    } finally {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      try {
        player.setOption('captions', 'track', previous && previous.languageCode ? previous : {});
      } catch (e) { /* noop */ }
    }

    return captured[0] || null;
  }

  /**
   * URLs de subtítulos con `pot` que el reproductor ya pidió en esta página.
   * Es gratis y no altera nada de la UI, así que se mira antes de forzar nada.
   */
  function timedTextUrlsFromPerformance() {
    try {
      return performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => n.includes('/api/timedtext') && n.includes('pot='))
        .reverse();
    } catch (e) {
      return [];
    }
  }

  /** Prueba una URL de sesión contra las pistas deseadas. */
  async function tryCapturedUrl(capturedUrl, orderedTracks) {
    for (const track of orderedTracks) {
      if (!track.baseUrl) continue;
      try {
        const res = await fetch(mergeCaptionUrl(capturedUrl, track.baseUrl), { credentials: 'include' });
        if (!res.ok) {
          log.push('player timedtext HTTP ' + res.status);
          continue;
        }
        const parsed = parseTimedText(await res.text());
        if (parsed) return { text: parsed, track };
      } catch (e) {
        log.push('player timedtext: ' + e.message);
      }
    }
    return null;
  }

  /** Descarga los subtítulos usando los parámetros de sesión del reproductor. */
  async function fromPlayerSession(orderedTracks) {
    // 2a. URLs que el reproductor ya pidió por su cuenta (sin efectos visibles).
    for (const url of timedTextUrlsFromPerformance().slice(0, 3)) {
      const hit = await tryCapturedUrl(url, orderedTracks);
      if (hit) return hit;
    }
    log.push('player: URLs de performance agotadas');

    // 2b. Forzar al reproductor a pedirlas para capturar una URL fresca.
    const player = document.querySelector('#movie_player');
    if (!player || typeof player.getOption !== 'function') {
      log.push('player: #movie_player no disponible');
      return null;
    }

    try { player.loadModule('captions'); } catch (e) { /* noop */ }
    await sleep(300);

    let tracklist = [];
    try { tracklist = player.getOption('captions', 'tracklist') || []; } catch (e) { /* noop */ }
    if (!tracklist.length) {
      log.push('player: tracklist vacía');
      return null;
    }

    // Se intenta primero la pista preferida; si está cacheada no genera
    // petición de red, así que se recorren las demás hasta capturar una URL.
    const preferredCode = orderedTracks[0] && orderedTracks[0].languageCode;
    const candidates = tracklist
      .slice()
      .sort((a, b) => (b.languageCode === preferredCode) - (a.languageCode === preferredCode));

    const capturedUrl = await capturePlayerCaptionUrl(player, candidates);
    if (!capturedUrl) {
      log.push('player: no se capturó ninguna URL con pot');
      return null;
    }

    const hit = await tryCapturedUrl(capturedUrl, orderedTracks);
    if (hit) return hit;

    log.push('player: URL capturada pero todas las pistas vinieron vacías');
    return null;
  }

  /** Endpoint interno que usa el propio panel de transcripción de YouTube. */
  async function fromInnertube() {
    const cfg = window.ytcfg;
    const apiKey = cfg && typeof cfg.get === 'function' ? cfg.get('INNERTUBE_API_KEY') : null;
    const context = cfg && typeof cfg.get === 'function' ? cfg.get('INNERTUBE_CONTEXT') : null;
    if (!apiKey || !context) {
      log.push('innertube: falta ytcfg');
      return '';
    }

    let params = null;
    try {
      const serialized = JSON.stringify(window.ytInitialData || {});
      const match = serialized.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/);
      if (match) params = match[1];
    } catch (e) {
      log.push('innertube: ytInitialData no serializable');
    }
    if (!params) {
      log.push('innertube: sin getTranscriptEndpoint');
      return '';
    }

    const res = await fetch('/youtubei/v1/get_transcript?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, params })
    });
    if (!res.ok) {
      log.push('innertube HTTP ' + res.status);
      return '';
    }

    const data = await res.json();
    const parts = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      const snippet = node.transcriptSegmentRenderer && node.transcriptSegmentRenderer.snippet;
      if (snippet) {
        const t = snippet.simpleText || (snippet.runs || []).map((r) => r.text).join('');
        if (t) parts.push(t);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const key of Object.keys(node)) walk(node[key]);
    })(data);

    return clean(parts.join(' '));
  }

  /** Último recurso: abrir el panel "Mostrar transcripción" y leer el DOM. */
  async function fromTranscriptPanel() {
    const readSegments = () => {
      const els = Array.from(
        document.querySelectorAll(
          'ytd-transcript-segment-renderer, ytd-transcript-body-renderer ytd-transcript-segment-renderer'
        )
      );
      return els
        .map((el) => {
          const textEl = el.querySelector('.segment-text, #segment-text, yt-formatted-string.segment-text') || el;
          return clean(textEl.textContent);
        })
        .filter(Boolean);
    };

    let segments = readSegments();
    if (segments.length) return clean(segments.join(' '));

    // Desplegar la descripción
    const expand = document.querySelector(
      '#description-inline-expander #expand, tp-yt-paper-button#expand, ytd-text-inline-expander #expand, #expand-sizer'
    );
    if (expand && expand.offsetHeight > 0) {
      expand.click();
      await sleep(400);
    }

    // Buscar el botón de transcripción (compatible con layout clásico y moderno)
    let button = document.querySelector(
      'ytd-video-description-transcript-section-renderer button, ytd-structured-description-content-renderer button, button[aria-label*="transcrip" i], button[aria-label*="transcript" i]'
    );
    if (!button) {
      const candidates = Array.from(
        document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape, ytd-button-renderer')
      );
      button = candidates.find((b) => {
        const label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return label.includes('transcripci') || label.includes('transcript');
      });
      if (button && button.tagName !== 'BUTTON') {
        button = button.querySelector('button') || button;
      }
    }

    if (!button) {
      log.push('panel: botón de transcripción no encontrado');
      return '';
    }

    button.click();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      segments = readSegments();
      if (segments.length) break;
    }

    if (!segments.length) log.push('panel: no aparecieron segmentos');
    return clean(segments.join(' '));
  }

  const playerResponse = getPlayerResponse();
  const title =
    playerResponse?.videoDetails?.title ||
    clean((document.title || '').replace(/-\s*YouTube$/i, '')) ||
    'Video de YouTube';
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  const trackName = (t) =>
    t?.name?.simpleText || t?.name?.runs?.[0]?.text || t?.languageCode || 'Desconocido';

  // Orden de preferencia: español > inglés > resto; subtítulos manuales antes que ASR.
  const score = (t) => {
    let s = 0;
    if (t.languageCode && t.languageCode.startsWith('es')) s -= 10;
    else if (t.languageCode && t.languageCode.startsWith('en')) s -= 5;
    if (t.kind === 'asr') s += 1;
    return s;
  };
  const ordered = tracks.slice().sort((a, b) => score(a) - score(b));

  log.push('pistas detectadas: ' + tracks.map((t) => t.languageCode + (t.kind === 'asr' ? '/asr' : '')).join(', '));

  // Capa 1: timedtext desde el contexto de la página (probando todas las pistas).
  for (const track of ordered) {
    if (!track.baseUrl) continue;
    const text = await fetchTimedText(track.baseUrl);
    if (text) {
      return {
        ok: true,
        transcript: text,
        title,
        language: trackName(track),
        source: 'timedtext',
        log
      };
    }
  }

  // Capa 2: sesión del reproductor (aporta el token `pot`). Es la que funciona
  // en la mayoría de vídeos actuales, donde el baseUrl "pelado" devuelve 0 bytes.
  try {
    const result = await fromPlayerSession(ordered);
    if (result && result.text) {
      return {
        ok: true,
        transcript: result.text,
        title,
        language: trackName(result.track),
        source: 'player-session',
        log
      };
    }
  } catch (e) {
    log.push('player: ' + e.message);
  }

  // Capa 3: endpoint interno get_transcript.
  try {
    const text = await fromInnertube();
    if (text) {
      return {
        ok: true,
        transcript: text,
        title,
        language: ordered[0] ? trackName(ordered[0]) : 'Auto',
        source: 'get_transcript',
        log
      };
    }
  } catch (e) {
    log.push('innertube: ' + e.message);
  }

  // Capa 4: scraping del panel del DOM.
  try {
    const text = await fromTranscriptPanel();
    if (text) {
      return {
        ok: true,
        transcript: text,
        title,
        language: ordered[0] ? trackName(ordered[0]) : 'Auto',
        source: 'panel-dom',
        log
      };
    }
  } catch (e) {
    log.push('panel: ' + e.message);
  }

  return { ok: false, hasTracks: tracks.length > 0, title, log };
}

/**
 * Primary Extraction Function
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{success: boolean, title: string, transcript: string, language: string, wordCount: number}>}
 */
export async function getTranscriptForTab(tab) {
  if (!tab || !tab.url) {
    throw new Error('No se pudo acceder a la pestaña activa.');
  }

  const videoId = extractVideoId(tab.url);
  if (!videoId) {
    throw new Error('No se detectó un ID de video de YouTube válido en la URL.');
  }

  const fallbackTitle = tab.title ? tab.title.replace(/-\s*YouTube$/i, '').trim() : 'Video de YouTube';

  const buildResult = (title, transcript, language) => ({
    success: true,
    title: title || fallbackTitle,
    transcript,
    language: language || 'Auto',
    wordCount: transcript.split(/\s+/).filter(Boolean).length
  });

  // Tier 1: extracción completa dentro de la página (mundo MAIN).
  let pageResult = null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pageTranscriptExtractor
    });
    pageResult = injection?.result || null;
    if (pageResult?.log?.length) {
      console.info('[youtube-service] traza de la página:', pageResult.log);
    }
    if (pageResult?.ok && pageResult.transcript) {
      console.info('[youtube-service] transcripción obtenida vía', pageResult.source);
      return buildResult(pageResult.title, pageResult.transcript, pageResult.language);
    }
  } catch (e) {
    console.warn('[youtube-service] Tier 1 (MAIN world) falló:', e);
  }

  // Tier 2: content script (mundo aislado) por si la inyección MAIN fue bloqueada.
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_TRANSCRIPT' });
    if (response && response.success && response.transcript) {
      console.info('[youtube-service] transcripción obtenida vía content script');
      return buildResult(response.title, response.transcript, response.language);
    }
    if (response && response.error) {
      console.warn('[youtube-service] content script:', response.error);
    }
  } catch (e) {
    console.warn('[youtube-service] Tier 2 (content script) falló:', e);
  }

  // Tier 3: API youtubei desde la extensión. Casi siempre devuelve pistas cuyo
  // timedtext viene vacío fuera de la sesión, pero se intenta igualmente.
  try {
    const apiRes = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240301.00.00',
            hl: 'es',
            gl: 'ES'
          }
        }
      })
    });

    if (apiRes.ok) {
      const data = await apiRes.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const preferred =
        tracks.find((t) => t.languageCode?.startsWith('es')) ||
        tracks.find((t) => t.languageCode?.startsWith('en')) ||
        tracks[0];

      if (preferred?.baseUrl) {
        const text = await fetchAndParseTranscriptText(preferred.baseUrl);
        if (text) {
          const lang =
            preferred.name?.simpleText || preferred.name?.runs?.[0]?.text || preferred.languageCode;
          return buildResult(data?.videoDetails?.title, text, lang);
        }
      }
    }
  } catch (e) {
    console.warn('[youtube-service] Tier 3 (youtubei) falló:', e);
  }

  if (pageResult && pageResult.hasTracks === false) {
    throw new Error('Este video no tiene subtítulos ni transcripción disponibles.');
  }

  throw new Error(
    'El video tiene subtítulos, pero YouTube devolvió la transcripción vacía. ' +
    'Recarga la página del video (F5) e inténtalo de nuevo; si persiste, abre ' +
    '"Mostrar transcripción" bajo la descripción y vuelve a pulsar Resumir.'
  );
}
