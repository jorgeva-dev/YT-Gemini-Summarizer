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

  const segments = [];

  // Attempt JSON3 parse
  if (rawText.trim().startsWith('{')) {
    try {
      const data = JSON.parse(rawText);
      if (data.events && Array.isArray(data.events)) {
        for (const evt of data.events) {
          if (evt.segs && Array.isArray(evt.segs)) {
            let evtOut = '';
            for (const seg of evt.segs) {
              if (seg.utf8) evtOut += seg.utf8 + ' ';
            }
            const cleanEvtOut = evtOut.replace(/\s+/g, ' ').trim();
            if (cleanEvtOut) {
              fullText += cleanEvtOut + ' ';
              segments.push({ tMs: evt.tStartMs || 0, text: cleanEvtOut });
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
        const node = nodes[i];
        const decoded = decodeEntities(node.textContent);
        if (decoded) {
          fullText += decoded + ' ';
          const tMs = Math.floor(parseFloat(node.getAttribute('start') || '0') * 1000);
          segments.push({ tMs, text: decoded });
        }
      }
    }
  }

  return { text: fullText.replace(/\s+/g, ' ').trim(), segments };
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
    if (!text) return { text: '', segments: [] };

    if (text.startsWith('{')) {
      try {
        const data = JSON.parse(text);
        let out = '';
        const segments = [];
        for (const evt of data.events || []) {
          let evtOut = '';
          for (const seg of evt.segs || []) {
            if (seg.utf8) evtOut += seg.utf8 + ' ';
          }
          const cleanEvtOut = clean(evtOut);
          if (cleanEvtOut) {
            out += cleanEvtOut + ' ';
            segments.push({ tMs: evt.tStartMs || 0, text: cleanEvtOut });
          }
        }
        return { text: clean(out), segments };
      } catch (e) {
        return { text: '', segments: [] };
      }
    }

    if (text.startsWith('<')) {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      let out = '';
      const segments = [];
      // srv1 / plain XML: <text start=".." dur="..">
      for (const node of Array.from(doc.getElementsByTagName('text'))) {
        const d = decode(node.textContent);
        if (d) {
          out += d + ' ';
          const tMs = Math.floor(parseFloat(node.getAttribute('start') || '0') * 1000);
          segments.push({ tMs, text: d });
        }
      }
      // srv3: <p><s>..</s></p>
      if (!clean(out)) {
        for (const node of Array.from(doc.getElementsByTagName('p'))) {
          const d = decode(node.textContent);
          if (d) {
            out += d + ' ';
            const tMs = parseInt(node.getAttribute('t') || '0', 10);
            segments.push({ tMs, text: d });
          }
        }
      }
      return { text: clean(out), segments };
    }

    return { text: '', segments: [] };
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
        if (parsed && parsed.text) return parsed;
        log.push('timedtext respuesta vacía (bytes=' + raw.length + ')');
      } catch (e) {
        log.push('timedtext fetch: ' + e.message);
      }
    }
    return { text: '', segments: [] };
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
        if (parsed && parsed.text) return { text: parsed.text, segments: parsed.segments, track };
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

    // 2b. Forzar al reproductor a pedirlas para capturar una URL fresca con pot.
    const player = document.querySelector('#movie_player');
    if (!player || typeof player.getOption !== 'function') {
      log.push('player: #movie_player no disponible');
      return null;
    }

    // e) Guardar el estado inicial de subtítulos del usuario
    let wasSubtitlesOn = false;
    try {
      wasSubtitlesOn = typeof player.isSubtitlesOn === 'function' ? player.isSubtitlesOn() : false;
    } catch (e) { /* noop */ }
    let previousTrack = null;
    try {
      previousTrack = player.getOption('captions', 'track');
    } catch (e) { /* noop */ }

    // a) Construir lista de candidatas a partir de orderedTracks sin depender de getOption('captions','tracklist')
    const candidates = orderedTracks.map((t) => ({
      languageCode: t.languageCode,
      kind: t.kind,
      vss_id: t.vssId || t.vss_id
    }));

    try {
      const playerTracklist = player.getOption('captions', 'tracklist') || [];
      for (const pt of playerTracklist) {
        if (
          pt &&
          pt.languageCode &&
          !candidates.some((c) => c.languageCode === pt.languageCode && c.kind === pt.kind)
        ) {
          candidates.push(pt);
        }
      }
    } catch (e) { /* noop */ }

    if (!candidates.length) {
      log.push('player: sin pistas candidatas');
      return null;
    }

    // Hooks de fetch/XHR como red de seguridad
    const capturedFromHooks = [];
    const recordHook = (url) => {
      const str = String(url || '');
      if (str.includes('/api/timedtext') && str.includes('pot=')) capturedFromHooks.push(str);
    };

    const origFetch = window.fetch;
    const origOpen = XMLHttpRequest.prototype.open;

    window.fetch = function (input) {
      try {
        recordHook(typeof input === 'string' ? input : (input && input.url) || '');
      } catch (e) { /* noop */ }
      return origFetch.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      try { recordHook(url); } catch (e) { /* noop */ }
      return origOpen.apply(this, arguments);
    };

    // c) Helper para sondear performance (y hooks como fallback) buscando la URL más reciente
    const pollForUrl = async (maxMs = 2500, intervalMs = 250, initialLatest = null) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const perfUrls = timedTextUrlsFromPerformance();
        const latestPerf = perfUrls[0] || null;
        if (latestPerf && latestPerf !== initialLatest) {
          return latestPerf;
        }
        if (capturedFromHooks.length) {
          const latestHook = capturedFromHooks[capturedFromHooks.length - 1];
          if (latestHook && latestHook !== initialLatest) {
            return latestHook;
          }
        }
        await sleep(intervalMs);
      }
      return (
        timedTextUrlsFromPerformance()[0] ||
        (capturedFromHooks.length ? capturedFromHooks[capturedFromHooks.length - 1] : null) ||
        null
      );
    };

    try {
      // b) Nuevo disparador: recargar el módulo de subtítulos con la primera candidata
      const initialLatest = timedTextUrlsFromPerformance()[0] || null;
      try {
        if (typeof player.unloadModule === 'function') player.unloadModule('captions');
      } catch (e) { /* noop */ }
      await sleep(400);
      try {
        if (typeof player.loadModule === 'function') player.loadModule('captions');
      } catch (e) { /* noop */ }
      await sleep(800);
      try {
        player.setOption('captions', 'track', candidates[0]);
      } catch (e) { /* noop */ }

      let capturedUrl = await pollForUrl(2500, 250, initialLatest);
      if (capturedUrl) {
        const hit = await tryCapturedUrl(capturedUrl, orderedTracks);
        if (hit) return hit;
      }

      // d) Recorrer el resto de candidatas sólo si hace falta
      for (let i = 1; i < candidates.length; i++) {
        const cand = candidates[i];
        const beforeCandLatest = timedTextUrlsFromPerformance()[0] || null;
        try {
          player.setOption('captions', 'track', cand);
        } catch (e) {
          continue;
        }
        capturedUrl = await pollForUrl(2500, 250, beforeCandLatest);
        if (capturedUrl) {
          const hit = await tryCapturedUrl(capturedUrl, orderedTracks);
          if (hit) return hit;
        }
      }

      log.push('player: URL con pot no encontrada o pistas vacías tras todos los intentos');
      return null;
    } finally {
      // Restaurar hooks
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;

      // e) Restaurar estado de subtítulos del usuario
      try {
        if (!wasSubtitlesOn) {
          if (typeof player.isSubtitlesOn === 'function' && player.isSubtitlesOn()) {
            player.toggleSubtitles();
          } else if (typeof player.unloadModule === 'function') {
            player.unloadModule('captions');
          } else {
            player.setOption('captions', 'track', {});
          }
        } else if (previousTrack && previousTrack.languageCode) {
          player.setOption('captions', 'track', previousTrack);
        }
      } catch (e) { /* noop */ }
    }
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
    const segments = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      const snippet = node.transcriptSegmentRenderer && node.transcriptSegmentRenderer.snippet;
      if (snippet) {
        const t = snippet.simpleText || (snippet.runs || []).map((r) => r.text).join('');
        if (t) {
          parts.push(t);
          const startMs = parseInt(node.transcriptSegmentRenderer.startMs || '0', 10);
          segments.push({ tMs: startMs, text: t });
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const key of Object.keys(node)) walk(node[key]);
    })(data);

    return { text: clean(parts.join(' ')), segments };
  }

  /** Último recurso: abrir el panel "Mostrar transcripción" y leer el DOM. */
  async function fromTranscriptPanel() {
    const isVisible = (el) => Boolean(el && el.offsetParent !== null && el.offsetHeight > 0);

    const readSegments = () => {
      const els = Array.from(
        document.querySelectorAll(
          'ytd-transcript-segment-renderer, ytd-transcript-body-renderer ytd-transcript-segment-renderer'
        )
      );
      return els
        .map((el) => {
          const textEl = el.querySelector('.segment-text, #segment-text, yt-formatted-string.segment-text') || el;
          const timeEl = el.querySelector('.segment-timestamp, #segment-timestamp');
          const tText = timeEl ? clean(timeEl.textContent) : '0:00';
          const parts = tText.split(':').map(Number);
          let tMs = 0;
          if (parts.length === 3) tMs = (parts[0]*3600 + parts[1]*60 + parts[2]) * 1000;
          else if (parts.length === 2) tMs = (parts[0]*60 + parts[1]) * 1000;
          
          return { tMs, text: clean(textEl.textContent) };
        })
        .filter(s => s.text);
    };

    let segments = readSegments();
    if (segments.length) return { text: clean(segments.map(s => s.text).join(' ')), segments };

    // Desplegar la descripción
    const expand = document.querySelector(
      '#description-inline-expander #expand, tp-yt-paper-button#expand, ytd-text-inline-expander #expand, #expand-sizer'
    );
    if (expand && isVisible(expand)) {
      expand.click();
      await sleep(400);
    }

    // Buscar el botón de transcripción (compatible con layout clásico y moderno)
    const directSectionBtn = document.querySelector(
      'ytd-video-description-transcript-section-renderer button'
    );
    let button = directSectionBtn && isVisible(directSectionBtn) ? directSectionBtn : null;

    if (!button) {
      const candidates = Array.from(
        document.querySelectorAll(
          'ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer, ytd-structured-description-content-renderer button, button, tp-yt-paper-button, yt-button-shape, ytd-button-renderer'
        )
      );
      const matching = candidates.filter((b) => {
        if (!isVisible(b)) return false;
        const label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return label.includes('transcripci') || label.includes('transcript');
      });

      // Priorizar el que esté dentro de ytd-video-description-transcript-section-renderer
      button =
        matching.find((b) => b.closest('ytd-video-description-transcript-section-renderer')) ||
        matching[0] ||
        null;

      if (button && button.tagName !== 'BUTTON') {
        const innerBtn = button.querySelector('button');
        if (innerBtn && isVisible(innerBtn)) {
          button = innerBtn;
        }
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
    return { text: clean(segments.map(s => s.text).join(' ')), segments };
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

  for (const track of ordered) {
    if (!track.baseUrl) continue;
    const parsed = await fetchTimedText(track.baseUrl);
    if (parsed && parsed.text) {
      return {
        ok: true,
        transcript: parsed.text,
        segments: parsed.segments,
        title,
        language: trackName(track),
        source: 'timedtext',
        log
      };
    }
  }

  try {
    const result = await fromPlayerSession(ordered);
    if (result && result.text) {
      return {
        ok: true,
        transcript: result.text,
        segments: result.segments,
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
    const parsed = await fromInnertube();
    if (parsed && parsed.text) {
      return {
        ok: true,
        transcript: parsed.text,
        segments: parsed.segments,
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
    const parsed = await fromTranscriptPanel();
    if (parsed && parsed.text) {
      return {
        ok: true,
        transcript: parsed.text,
        segments: parsed.segments,
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

  const buildResult = (title, transcript, language, segments) => {
    let transcriptWithTimes = '';
    if (segments && segments.length > 0) {
      transcriptWithTimes = segments.map(seg => {
        const tSec = Math.floor(seg.tMs / 1000);
        const m = Math.floor(tSec / 60);
        const s = tSec % 60;
        return `[${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}] ${seg.text}`;
      }).join('\n');
    }
    
    return {
      success: true,
      title: title || fallbackTitle,
      transcript,
      transcriptWithTimes: transcriptWithTimes || transcript,
      language: language || 'Auto',
      wordCount: transcript.split(/\s+/).filter(Boolean).length
    };
  };

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
      return buildResult(pageResult.title, pageResult.transcript, pageResult.language, pageResult.segments);
    }
  } catch (e) {
    console.warn('[youtube-service] Tier 1 (MAIN world) falló:', e);
  }

  // Tier 2: content script (mundo aislado) por si la inyección MAIN fue bloqueada.
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_TRANSCRIPT' });
    if (response && response.success && response.transcript) {
      console.info('[youtube-service] transcripción obtenida vía content script');
      return buildResult(response.title, response.transcript, response.language, response.segments);
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
        const parsed = await fetchAndParseTranscriptText(preferred.baseUrl);
        if (parsed && parsed.text) {
          const lang =
            preferred.name?.simpleText || preferred.name?.runs?.[0]?.text || preferred.languageCode;
          return buildResult(data?.videoDetails?.title, parsed.text, lang, parsed.segments);
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
