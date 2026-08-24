import { getTranscriptForTab } from '../services/youtube-service.js';

// DOM Elements
const actionsContainer = document.getElementById('actionsContainer');
const openOptionsBtn = document.getElementById('openOptionsBtn');

// Views
const idleState = document.getElementById('idleState');
const loadingState = document.getElementById('loadingState');
const successState = document.getElementById('successState');
const errorState = document.getElementById('errorState');

// Loading Step elements
const stepTranscript = document.getElementById('stepTranscript');
const stepGemini = document.getElementById('stepGemini');

// Success view elements
const videoTitleDisplay = document.getElementById('videoTitleDisplay');
const metaLang = document.getElementById('metaLang');
const metaWords = document.getElementById('metaWords');
const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
const noticeTitle = document.getElementById('noticeTitle');

// Error view elements
const errorMessageText = document.getElementById('errorMessageText');
const retryBtn = document.getElementById('retryBtn');

let acciones = [];
let lastUsedActionId = null;
let currentFullPrompt = '';

// Initialize Side Panel
document.addEventListener('DOMContentLoaded', async () => {
  // Limpiar claves obsoletas de storage si existieran
  try {
    await chrome.storage.local.remove(['geminiApiKey', 'selectedModel', 'geminiTabId', 'pendingPrompt']);
  } catch (e) { /* noop */ }

  await loadActions();
  setupEventListeners();

  // Escuchar cambios de storage (si editan desde opciones con el panel abierto)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.acciones) {
      acciones = changes.acciones.newValue || [];
      renderActions();
    }
  });
});

async function loadActions() {
  const data = await chrome.storage.local.get('acciones');
  acciones = data.acciones || [];
  renderActions();
}

function renderActions() {
  actionsContainer.innerHTML = '';
  
  if (acciones.length === 0) {
    actionsContainer.innerHTML = `
      <div style="text-align:center; padding: 10px; color: var(--text-muted); font-size: 13px;">
        No tienes acciones configuradas. <br><br>
        <a href="#" id="linkOptions" style="color: #A855F7; text-decoration: underline;">Abrir configuración</a>
      </div>
    `;
    document.getElementById('linkOptions').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS' });
    });
    return;
  }

  acciones.forEach((acc, index) => {
    const btn = document.createElement('button');
    btn.className = index === 0 ? 'primary-btn' : 'secondary-action-btn';
    
    btn.innerHTML = `
      <span class="btn-icon">${acc.icono || '⚡'}</span>
      <span class="btn-text">${acc.nombre || 'Acción'}</span>
    `;
    
    btn.addEventListener('click', () => handleSummarizeClick(acc));

    if (acc.destino === 'gem') {
      const wrapper = document.createElement('div');
      wrapper.className = 'gem-btn-wrapper';
      wrapper.appendChild(btn);
      
      const sub = document.createElement('span');
      sub.className = 'gem-subtext';
      sub.textContent = 'Destino: Gem';
      wrapper.appendChild(sub);
      
      actionsContainer.appendChild(wrapper);
    } else {
      actionsContainer.appendChild(btn);
    }
  });
}

// Switch UI State Views
function showState(viewName) {
  idleState.classList.remove('active');
  loadingState.classList.remove('active');
  successState.classList.remove('active');
  errorState.classList.remove('active');

  if (viewName === 'idle') idleState.classList.add('active');
  if (viewName === 'loading') loadingState.classList.add('active');
  if (viewName === 'success') successState.classList.add('active');
  if (viewName === 'error') errorState.classList.add('active');
}

// Event Listeners Setup
function setupEventListeners() {
  openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS' });
  });

  retryBtn.addEventListener('click', () => {
    if (lastUsedActionId) {
      const action = acciones.find(a => a.id === lastUsedActionId);
      if (action) handleSummarizeClick(action);
    }
  });

  copyTranscriptBtn.addEventListener('click', () => {
    if (!currentFullPrompt) return;
    navigator.clipboard.writeText(currentFullPrompt).then(() => {
      const span = copyTranscriptBtn.querySelector('span');
      const originalText = span.textContent;
      span.textContent = '¡Copiado!';
      copyTranscriptBtn.style.color = '#22C55E';
      setTimeout(() => {
        span.textContent = originalText;
        copyTranscriptBtn.style.color = '';
      }, 2000);
    });
  });
}

/**
 * Manejador principal de extracción y envío dinámico.
 */
async function handleSummarizeClick(action) {
  lastUsedActionId = action.id;

  // Validar
  if (action.destino === 'gem' && (!action.gemUrl || !action.gemUrl.trim())) {
    showError('Configura la URL de tu Gem en las Opciones para usar esta acción.');
    return;
  }

  // 1. Query Active Tab (YouTube)
  showState('loading');
  stepTranscript.classList.add('active');
  stepGemini.classList.remove('active');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || !activeTab.url) {
    showError('No se pudo acceder a la pestaña activa.');
    return;
  }

  if (!activeTab.url.includes('youtube.com/watch')) {
    showError('La pestaña activa no es un reproductor de video de YouTube. Abre un video para usar las acciones.');
    return;
  }

  // 2. Extraer transcripción usando la ruta única de youtube-service
  let transcriptResponse = null;
  try {
    transcriptResponse = await getTranscriptForTab(activeTab);
  } catch (err) {
    showError(err.message || 'No se pudo obtener la transcripción del video.');
    return;
  }

  // 3. Sustituir placeholders
  let fullPrompt = action.prompt || '';
  fullPrompt = fullPrompt.replace(/\{\{titulo\}\}/g, transcriptResponse.title || '');
  fullPrompt = fullPrompt.replace(/\{\{transcripcion\}\}/g, transcriptResponse.transcript || '');
  fullPrompt = fullPrompt.replace(/\{\{url\}\}/g, activeTab.url || '');
  fullPrompt = fullPrompt.replace(/\{\{transcripcion_con_tiempos\}\}/g, transcriptResponse.transcriptWithTimes || transcriptResponse.transcript || '');

  currentFullPrompt = fullPrompt;

  // 4. Copiar prompt completo al portapapeles
  try {
    await navigator.clipboard.writeText(fullPrompt);
  } catch (e) {
    console.warn('[sidepanel] Error al copiar al portapapeles:', e);
  }

  // Mostrar datos del video
  videoTitleDisplay.textContent = transcriptResponse.title;
  metaLang.textContent = `Idioma: ${transcriptResponse.language || 'Auto'}`;
  metaWords.textContent = `~${transcriptResponse.wordCount || 0} palabras`;

  // 5. Destino Portapapeles
  if (action.destino === 'portapapeles') {
    noticeTitle.textContent = `✨ Copiado (${action.nombre})`;
    document.querySelector('.notice-text').textContent = 'El contenido no se envió a ninguna parte, solo se ha copiado en tu portapapeles.';
    document.querySelector('.notice-subtext').innerHTML = 'Pégalo donde necesites con <strong>Cmd + V</strong> (o <strong>Ctrl + V</strong>).';
    showState('success');
    return;
  }

  // 6. Actualizar pasos de carga
  stepTranscript.classList.remove('active');
  stepGemini.classList.add('active');

  // 7. Abrir pestaña de Gemini y registrar el prompt asociado a su tabId
  const targetUrl = action.destino === 'gem' ? action.gemUrl.trim() : 'https://gemini.google.com/app';

  try {
    const newTab = await chrome.tabs.create({
      windowId: activeTab.windowId,
      index: activeTab.index + 1,
      url: targetUrl,
      active: true
    });

    if (newTab && newTab.id) {
      const storageData = await chrome.storage.local.get('pendingPrompts');
      const pendingPrompts = storageData.pendingPrompts || {};

      // Purgar prompts antiguos (> 2 minutos)
      const now = Date.now();
      for (const id of Object.keys(pendingPrompts)) {
        if (!pendingPrompts[id]?.createdAt || now - pendingPrompts[id].createdAt > 2 * 60 * 1000) {
          delete pendingPrompts[id];
        }
      }

      pendingPrompts[newTab.id] = {
        text: fullPrompt,
        title: transcriptResponse.title,
        mode: action.nombre,
        createdAt: now
      };

      await chrome.storage.local.set({ pendingPrompts });
    }

    // Cerrar el side panel lateral
    setTimeout(() => {
      window.close();
    }, 100);

  } catch (e) {
    console.error('[sidepanel] Error al abrir pestaña de Gemini:', e);
  }

  // 8. Actualizar texto de estado de éxito (por si window.close se demorase)
  if (noticeTitle) {
    noticeTitle.textContent = `✨ Enviado a Gemini (${action.nombre})`;
  }
  document.querySelector('.notice-text').textContent = 'Se ha abierto una nueva pestaña a la derecha en Gemini con el contenido correspondiente.';
  document.querySelector('.notice-subtext').innerHTML = 'Si el pegado automático fallara, el contenido ya está copiado: sólo pulsa <strong>Cmd + V</strong> (o <strong>Ctrl + V</strong>) en el chat.';

  showState('success');
}

// Display Error UI State
function showError(message) {
  errorMessageText.textContent = message;
  showState('error');
}
