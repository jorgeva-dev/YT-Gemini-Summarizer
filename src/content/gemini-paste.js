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
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
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
        if (!element) return;
        try {
          element.removeAttribute('disabled');
          element.setAttribute('aria-disabled', 'false');
          element.classList.remove('disabled');
        } catch (e) {}

        const mouseEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const evtName of mouseEvents) {
          try {
            const evt = new MouseEvent(evtName, {
              bubbles: true,
              cancelable: true,
              view: window
            });
            element.dispatchEvent(evt);
          } catch (e) {}
        }

        if (typeof element.click === 'function') {
          try {
            element.click();
          } catch (e) {}
        }
      }

      function triggerEnter(target) {
        if (!target) return;
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
        sendBtn = findSendButton();
        if (sendBtn) {
          const isDisabled = sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
          if (!isDisabled) {
            break;
          }
          // Si sigue deshabilitado, re-notificar input al editor
          notifyInput();
        }
        await sleep(200);
      }

      // 1. Intentar hacer click en el botón de envío si se localizó
      if (sendBtn) {
        triggerClick(sendBtn);
        await sleep(300);
      }

      // 2. Comprobar si aún queda el texto en el editor y enviar pulsación de Enter
      const currentText = (editor.textContent || editor.value || '').trim();
      if (currentText.length > 0) {
        editor.focus();
        triggerEnter(editor);
        await sleep(200);
        
        // Si hay un botón de envío, volver a forzar el click tras el Enter
        if (sendBtn) {
          triggerClick(sendBtn);
        }
      }

      console.log('[gemini-paste] Proceso de inserción y auto-envío completado en Gemini/Gem.');

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
