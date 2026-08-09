/**
 * Content Script for gemini.google.com
 *
 * Lee la transcripción y la instrucción pendientes desde chrome.storage.local,
 * la borra inmediatamente, la inserta en el editor de chat de Gemini y la envía.
 */

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Inyecta estilos opcionales para ocultar la barra lateral de navegación de Gemini.
   * Nota: Estos selectores corresponden al DOM de Google y podrían cambiar con el tiempo.
   */
  function injectOptionalFocusStyles() {
    try {
      if (document.getElementById('yt-gemini-focus-styles')) return;
      const style = document.createElement('style');
      style.id = 'yt-gemini-focus-styles';
      style.textContent = `
        mat-drawer.mat-drawer,
        side-nav,
        .side-nav-host,
        bard-sidenav,
        gmat-nav-drawer {
          display: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {
      /* Ignorar si cambia el DOM */
    }
  }

  async function pasteAndSendPrompt() {
    try {
      // Solicitar al service worker el prompt asignado a esta pestaña
      const response = await chrome.runtime.sendMessage({ action: 'GET_PENDING_PROMPT' });
      if (!response || !response.prompt || !response.prompt.text) {
        // No hay prompt pendiente para esta pestaña; dejar sesión normal de Gemini
        return;
      }

      const { text } = response.prompt;

      // Opcional: ocultar la barra lateral para enfoque en el chat
      injectOptionalFocusStyles();

      // Polling para esperar a que exista el editor editable en Gemini (SPA)
      const editorSelectors = [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"]',
        '.input-area div[contenteditable="true"]',
        'textarea[aria-label*="Gemini" i]',
        'p[data-placeholder]'
      ];

      let editor = null;
      for (let i = 0; i < 60; i++) {
        for (const sel of editorSelectors) {
          const el = document.querySelector(sel);
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
            editor = el;
            break;
          }
        }
        if (editor) break;
        await sleep(250);
      }

      if (!editor) {
        console.warn('[gemini-paste] No se encontró el editor en Gemini. El texto permanece en el portapapeles.');
        return;
      }

      // Foco en el editor
      editor.focus();
      await sleep(150);

      // Inserción vía execCommand para disparar bindings de Angular / Quill / ProseMirror
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch (e) {
        inserted = false;
      }

      // Respaldo por si execCommand falla o no modifica el texto
      if (!inserted || !(editor.textContent || editor.value || '').trim()) {
        editor.focus();
        if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
          editor.value = text;
        } else {
          editor.textContent = text;
        }
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await sleep(350);

      // Polling para esperar a que el botón de envío esté habilitado y pulsar
      const sendBtnSelectors = [
        'button.send-button',
        'button[aria-label*="Enviar" i]',
        'button[aria-label*="Send" i]',
        'button.send-button-container button',
        '.input-area-container button[aria-label*="Enviar" i]',
        '.input-area-container button[aria-label*="Send" i]'
      ];

      let sendBtn = null;
      for (let i = 0; i < 25; i++) {
        for (const sel of sendBtnSelectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
            sendBtn = btn;
            break;
          }
        }
        if (sendBtn) break;
        await sleep(200);
      }

      if (sendBtn) {
        sendBtn.click();
        console.log('[gemini-paste] Transcripción e instrucciones enviadas con éxito a Gemini.');
      } else {
        console.warn('[gemini-paste] No se activó el botón de enviar. Puedes pulsar Enter o pegar con Cmd+V.');
      }

    } catch (err) {
      console.error('[gemini-paste] Error no crítico durante el pegado:', err);
    }
  }

  // Ejecutar al cargar la página o cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pasteAndSendPrompt);
  } else {
    pasteAndSendPrompt();
  }
})();
