/**
 * Content Script for gemini.google.com
 *
 * Lee la transcripción y la instrucción pendientes desde chrome.storage.local,
 * la borra inmediatamente, la inserta en el editor de chat de Gemini y la envía.
 */

(function () {
  // Evitar ejecuciones duplicadas del script en la misma pestaña
  if (window.__ytGeminiPasteExecuted) return;
  window.__ytGeminiPasteExecuted = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Inyecta estilos opcionales para ocultar la barra lateral de navegación de Gemini.
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

      // Notificar al framework (Angular/Lit/ProseMirror) para habilitar el botón de envío
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

      // Helper para buscar el botón de envío específico del área de chat
      function findSendButton() {
        const inputContainer = editor.closest('.input-area-container') ||
                              editor.closest('.input-area') ||
                              editor.closest('rich-textarea')?.parentElement ||
                              editor.closest('chat-window') ||
                              document.querySelector('.bottom-container') ||
                              document.querySelector('footer') ||
                              document;

        const sendBtnSelectors = [
          'button.send-button',
          'button[aria-label*="Enviar" i]',
          'button[aria-label*="Send" i]',
          'button[data-test-id*="send" i]',
          'button[data-test-id*="submit" i]',
          '.send-button-container button',
          'button.speech-to-text-and-send-button'
        ];

        for (const sel of sendBtnSelectors) {
          const el = inputContainer.querySelector(sel);
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0) && !isStopButton(el)) {
            return el;
          }
        }

        // Búsqueda por contenido/iconos dentro del contenedor del input.
        //
        // Antes bastaba con que el HTML interno del botón contuviera "send" en
        // cualquier parte, lo que podía casar con el botón "+" de adjuntar. Al
        // pulsarlo se abría su menú (Calendar, Keep, Tasks, Drive...) en vez de
        // enviar. Ahora la etiqueta accesible manda, y los botones de menú
        // quedan excluidos explícitamente.
        const buttons = inputContainer.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          if (isStopButton(btn) || isMenuButton(btn)) continue;
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

          if (aria.includes('send') || aria.includes('enviar')) return btn;
          if (btn.classList.contains('send-button')) return btn;

          // Los iconos sólo se admiten si son inequívocos y el botón no tiene
          // etiqueta que lo desmienta.
          const icono = (btn.textContent || '').trim().toLowerCase();
          if (!aria && (icono === 'send' || icono === 'send_spark' || icono === 'arrow_upward')) {
            return btn;
          }
        }

        return null;
      }

      /**
       * ¿Es un botón de menú, adjuntar o herramientas? Pulsarlos abre paneles
       * en vez de enviar, y al usuario le parece que la extensión ha hecho algo
       * raro.
       */
      function isMenuButton(el) {
        if (!el) return false;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const test = (el.getAttribute('data-test-id') || '').toLowerCase();
        const patrones = [
          'add', 'añad', 'anad', 'adjunt', 'attach', 'upload', 'subir',
          'menu', 'menú', 'more', 'más', 'mas opciones', 'tool', 'herramient',
          'file', 'archivo', 'imagen', 'image', 'mic', 'micr', 'voice', 'voz'
        ];
        return patrones.some((p) => aria.includes(p) || test.includes(p));
      }

      function clickButton(element) {
        if (!element || isStopButton(element) || isGenerating()) return;
        // Sólo se fuerza la habilitación de algo que sí parece el botón de
        // enviar: quitarle el disabled a un botón cualquiera es cómo se acaba
        // pulsando lo que no toca.
        const aria = (element.getAttribute('aria-label') || '').toLowerCase();
        const esEnviar = aria.includes('send') || aria.includes('enviar') ||
                         element.classList.contains('send-button');
        if (esEnviar) {
          try {
            element.removeAttribute('disabled');
            element.setAttribute('aria-disabled', 'false');
            element.classList.remove('disabled');
          } catch (e) {}
        }

        try {
          element.click();
        } catch (e) {
          console.warn('[gemini-paste] Error al hacer clic en el botón:', e);
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
        } catch (e) {}
      }

      // Polling para esperar a que el botón de envío esté presente y habilitado
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

      // Envío estricto de una única vez
      if (sendBtn && !isStopButton(sendBtn)) {
        clickButton(sendBtn);
        console.log('[gemini-paste] Envío realizado con éxito mediante clic único.');
        return;
      }

      // Como fallback si no se localizó botón activo, disparar Enter una sola vez
      editor.focus();
      triggerEnter(editor);
      console.log('[gemini-paste] Envío realizado mediante pulsación de Enter.');

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
