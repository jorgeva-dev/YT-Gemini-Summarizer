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
      }

      // Notificar siempre al framework (Angular/Lit/ProseMirror) para habilitar el botón de envío
      const notifyInput = () => {
        try {
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
          editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          const pChild = editor.querySelector('p');
          if (pChild) {
            pChild.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
            pChild.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          }
        } catch (e) { /* ignore */ }
      };

      notifyInput();
      await sleep(250);

      // Helper para verificar si un botón es el de "Detener / Stop"
      function isStopButton(btn) {
        if (!btn) return false;
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const html = btn.innerHTML.toLowerCase();
        return aria.includes('stop') || aria.includes('detener') || aria.includes('parar') ||
               aria.includes('cancel') || html.includes('stop') || btn.classList.contains('stop-button');
      }

      // Helper para comprobar si Gemini ya ha comenzado a generar la respuesta
      function isGenerating() {
        const stopSelectors = [
          'button[aria-label*="Stop" i]',
          'button[aria-label*="Detener" i]',
          'button[aria-label*="Parar" i]',
          'button.stop-button',
          '.stop-icon',
          'mat-icon[fonticon="stop"]',
          'mat-icon[data-mat-icon-name="stop"]'
        ];
        for (const sel of stopSelectors) {
          const el = document.querySelector(sel);
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) return true;
        }
        return false;
      }

      // Helper para buscar el botón de envío (tanto en Gemini estándar como en Gems)
      function findSendButton() {
        const sendBtnSelectors = [
          'button.send-button',
          'button[aria-label*="Enviar" i]',
          'button[aria-label*="Send" i]',
          'button[aria-label*="prompt" i]',
          'button[aria-label*="Submit" i]',
          'button[aria-label*="mensaje" i]',
          'button[aria-label*="message" i]',
          'button[data-test-id*="send" i]',
          'button[data-test-id*="submit" i]',
          '.send-button-container button',
          '.input-area-container button[aria-label*="Enviar" i]',
          '.input-area-container button[aria-label*="Send" i]',
          '.input-area-container button.send-button',
          'button.speech-to-text-and-send-button',
          'div[role="button"][aria-label*="Enviar" i]',
          'div[role="button"][aria-label*="Send" i]',
          'div[role="button"][aria-label*="prompt" i]'
        ];

        for (const sel of sendBtnSelectors) {
          const el = document.querySelector(sel);
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0) && !isStopButton(el)) {
            return el;
          }
        }

        // Búsqueda en el contenedor del editor o barra inferior
        const container = editor.closest('.input-area-container') ||
                          editor.closest('.input-area') ||
                          editor.closest('rich-textarea')?.parentElement ||
                          document.querySelector('.bottom-container') ||
                          document.querySelector('footer');

        if (container) {
          const buttons = container.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            if (isStopButton(btn)) continue;
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const html = btn.innerHTML.toLowerCase();
            if (
              aria.includes('send') || aria.includes('enviar') || aria.includes('prompt') ||
              html.includes('send') || html.includes('send_spark') || html.includes('arrow_upward') ||
              btn.classList.contains('send-button')
            ) {
              return btn;
            }
          }
        }

        return null;
      }

      function triggerClick(element) {
        if (!element || isStopButton(element) || isGenerating()) return;
        try {
          element.removeAttribute('disabled');
          element.setAttribute('aria-disabled', 'false');
          element.classList.remove('disabled');
        } catch (e) {}

        const mouseEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const evtName of mouseEvents) {
          if (isStopButton(element) || isGenerating()) return;
          try {
            const evt = new MouseEvent(evtName, {
              bubbles: true,
              cancelable: true,
              view: window
            });
            element.dispatchEvent(evt);
          } catch (e) {}
        }

        if (typeof element.click === 'function' && !isStopButton(element) && !isGenerating()) {
          try {
            element.click();
          } catch (e) {}
        }
      }

      function triggerEnter(target) {
        if (!target || isGenerating()) return;
        const enterOpts = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: 13,
          bubbles: true,
          cancelable: true
        };
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
          target.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          target.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
        } catch (e) {}
      }

      // Polling para esperar a que el botón de envío esté presente/habilitado
      let sendBtn = null;
      for (let i = 0; i < 35; i++) {
        if (isGenerating()) {
          console.log('[gemini-paste] Generación ya iniciada detectada.');
          return;
        }

        sendBtn = findSendButton();
        if (sendBtn && !isStopButton(sendBtn)) {
          const isDisabled = sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
          if (!isDisabled) {
            break;
          }
          // Si sigue deshabilitado, re-notificar input al editor
          notifyInput();
        }
        await sleep(200);
      }

      if (isGenerating()) {
        console.log('[gemini-paste] Generación en curso, finalizando script.');
        return;
      }

      // 1. Intentar hacer click en el botón de envío si se localizó
      if (sendBtn && !isStopButton(sendBtn)) {
        triggerClick(sendBtn);
        await sleep(400);
      }

      // Si la generación ya arrancó, terminar inmediatamente para evitar detenerla
      if (isGenerating()) {
        console.log('[gemini-paste] Envío iniciado con éxito tras click.');
        return;
      }

      // 2. Si todavía no ha empezado a generar, enviar pulsación de Enter
      editor.focus();
      triggerEnter(editor);
      await sleep(400);

      if (isGenerating()) {
        console.log('[gemini-paste] Envío iniciado con éxito tras Enter.');
        return;
      }

      // 3. Como último recurso, buscar de nuevo el botón y hacer clic si sigue inactivo
      const freshBtn = findSendButton();
      if (freshBtn && !isStopButton(freshBtn) && !isGenerating()) {
        triggerClick(freshBtn);
      }

      console.log('[gemini-paste] Proceso de inserción completado.');

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
