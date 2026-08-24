/**
 * YouTube Transcript Extractor - Content Script
 *
 * Respaldo del extractor principal (src/services/youtube-service.js), que se
 * inyecta en el mundo MAIN. Este script vive en el mundo aislado, así que NO
 * puede leer window.ytInitialPlayerResponse: obtiene las pistas rastreando el
 * HTML y, si el timedtext viene vacío, lee el panel de transcripción del DOM.
 *
 * Nota: aquí no se inyectan <script> inline en la página porque la CSP de
 * YouTube los bloquea; esa vía se hace desde chrome.scripting con world MAIN.
 */

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();

  /**
   * Decodes HTML entities in text content.
   * @param {string} str
   * @returns {string}
   */
  function decodeHTMLEntities(str) {
    if (!str) return '';
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return clean(
      textarea.value
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
    );
  }

  /**
   * Bracket balancing helper to cleanly extract captionTracks JSON array from raw text.
   * Avoids fragile regex truncation bugs.
   */
  function extractCaptionTracksFromText(text) {
    if (!text) return null;
    const key = '"captionTracks":';
    const idx = text.indexOf(key);
    if (idx === -1) return null;

    const startBracket = text.indexOf('[', idx);
    if (startBracket === -1) return null;

    let depth = 0;
    let endBracket = -1;
    let inString = false;
    let escape = false;

    for (let i = startBracket; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[') depth++;
        else if (char === ']') {
          depth--;
          if (depth === 0) {
            endBracket = i;
            break;
          }
        }
      }
    }

    if (endBracket !== -1) {
      const jsonArrayStr = text.substring(startBracket, endBracket + 1);
      try {
        const tracks = JSON.parse(jsonArrayStr);
        if (Array.isArray(tracks) && tracks.length > 0) {
          return tracks;
        }
      } catch (e) {
        console.warn('[yt-transcript] JSON parse error on extracted captionTracks:', e);
      }
    }
    return null;
  }

  /**
   * Busca las pistas de subtítulos rastreando el HTML de la página.
   */
  async function extractCaptionTracks() {
    // 1. Scan script tags in current DOM
    const scriptTags = Array.from(document.querySelectorAll('script'));
    for (const script of scriptTags) {
      const content = script.textContent || '';
      if (content.includes('captionTracks')) {
        const tracks = extractCaptionTracksFromText(content);
        if (tracks) {
          console.log('[yt-transcript] Found tracks via DOM <script> tag');
          return tracks;
        }
      }
    }

    // 2. Scan full innerHTML of document
    const fullHtml = document.documentElement.innerHTML;
    if (fullHtml.includes('captionTracks')) {
      const tracks = extractCaptionTracksFromText(fullHtml);
      if (tracks) {
        console.log('[yt-transcript] Found tracks via document innerHTML');
        return tracks;
      }
    }

    // 3. Fetch current URL directly (fresh page HTML fallback)
    try {
      const res = await fetch(window.location.href, { credentials: 'include' });
      if (res.ok) {
        const htmlText = await res.text();
        const tracks = extractCaptionTracksFromText(htmlText);
        if (tracks) {
          console.log('[yt-transcript] Found tracks via fresh page fetch');
          return tracks;
        }
      }
    } catch (e) {
      console.warn('[yt-transcript] Fresh page fetch fallback failed:', e);
    }

    return null;
  }

  /**
   * Parsea un payload de timedtext (json3, srv1/XML o srv3).
   */
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
        console.warn('[yt-transcript] JSON timedtext parse fail:', e);
        return { text: '', segments: [] };
      }
    }

    if (text.startsWith('<')) {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      let out = '';
      const segments = [];
      for (const node of Array.from(doc.getElementsByTagName('text'))) {
        const decoded = decodeHTMLEntities(node.textContent);
        if (decoded) {
          out += decoded + ' ';
          const tMs = Math.floor(parseFloat(node.getAttribute('start') || '0') * 1000);
          segments.push({ tMs, text: decoded });
        }
      }
      if (!clean(out)) {
        for (const node of Array.from(doc.getElementsByTagName('p'))) {
          const decoded = decodeHTMLEntities(node.textContent);
          if (decoded) {
            out += decoded + ' ';
            const tMs = parseInt(node.getAttribute('t') || '0', 10);
            segments.push({ tMs, text: decoded });
          }
        }
      }
      return { text: clean(out), segments };
    }

    return { text: '', segments: [] };
  }

  /**
   * Descarga el baseUrl probando varios formatos hasta obtener contenido.
   * YouTube responde 200 con cuerpo vacío si el formato o la sesión no encajan.
   */
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
          console.warn('[yt-transcript] timedtext HTTP', res.status);
          continue;
        }
        const raw = await res.text();
        const parsed = parseTimedText(raw);
        if (parsed && parsed.text) return parsed;
        console.warn('[yt-transcript] timedtext vacío, bytes =', raw.length);
      } catch (e) {
        console.warn('[yt-transcript] timedtext fetch error:', e);
      }
    }
    return { text: '', segments: [] };
  }

  /**
   * Último recurso: abre el panel "Mostrar transcripción" y lee sus segmentos.
   */
  async function scrapeTranscriptPanel() {
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

    const expand = document.querySelector(
      '#description-inline-expander #expand, tp-yt-paper-button#expand, ytd-text-inline-expander #expand, #expand-sizer'
    );
    if (expand && expand.offsetHeight > 0) {
      expand.click();
      await sleep(400);
    }

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
    if (!button) return { text: '', segments: [] };

    button.click();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      segments = readSegments();
      if (segments.length) break;
    }

    return { text: clean(segments.map(s => s.text).join(' ')), segments };
  }

  /**
   * Main function to extract full transcript from active video.
   */
  async function getTranscript() {
    try {
      // Ensure we are on a valid YouTube video page
      if (!window.location.pathname.includes('/watch') && !window.location.search.includes('v=')) {
        return { success: false, error: 'Por favor, abre una página de reproductor de video de YouTube (youtube.com/watch?v=...)' };
      }

      const captionTracks = (await extractCaptionTracks()) || [];

      // Preferencia: español > inglés > resto; manuales antes que automáticos.
      const score = (t) => {
        let s = 0;
        if (t.languageCode && t.languageCode.startsWith('es')) s -= 10;
        else if (t.languageCode && t.languageCode.startsWith('en')) s -= 5;
        if (t.kind === 'asr') s += 1;
        return s;
      };
      const ordered = captionTracks.slice().sort((a, b) => score(a) - score(b));

      const trackName = (t) =>
        t?.name?.simpleText || t?.name?.runs?.[0]?.text || t?.languageCode || 'Desconocido';

      let rawTitle = document.title || 'Video de YouTube';
      const cleanTitle = rawTitle.replace(/-\s*YouTube$/i, '').trim();

      let fullTranscript = '';
      let language = 'Auto';
      let segments = [];

      for (const track of ordered) {
        if (!track.baseUrl) continue;
        const parsed = await fetchTimedText(track.baseUrl);
        if (parsed && parsed.text) {
          fullTranscript = parsed.text;
          segments = parsed.segments;
          language = trackName(track);
          break;
        }
      }

      // Si timedtext viene vacío (sesión/token), leemos el panel del DOM.
      if (!fullTranscript) {
        const parsed = await scrapeTranscriptPanel();
        if (parsed && parsed.text) {
          fullTranscript = parsed.text;
          segments = parsed.segments;
          if (ordered[0]) language = trackName(ordered[0]);
        }
      }

      if (!fullTranscript) {
        if (captionTracks.length === 0) {
          return {
            success: false,
            error: 'No se encontraron subtítulos o transcripción en este video. Es posible que el creador no haya habilitado subtítulos.'
          };
        }
        return {
          success: false,
          error: 'El video tiene subtítulos pero YouTube devolvió el contenido vacío. Recarga la página e inténtalo de nuevo.'
        };
      }
      
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
        title: cleanTitle,
        transcript: fullTranscript,
        transcriptWithTimes: transcriptWithTimes || fullTranscript,
        language,
        segments,
        wordCount: fullTranscript.split(/\s+/).filter(Boolean).length
      };

    } catch (err) {
      console.error('[yt-transcript] Error extraction:', err);
      return { success: false, error: err.message || 'Error desconocido al extraer la transcripción.' };
    }
  }

  // Listener for message calls from sidepanel or background worker
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'EXTRACT_TRANSCRIPT') {
      getTranscript().then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep message channel open for async response
    }
  });
})();
