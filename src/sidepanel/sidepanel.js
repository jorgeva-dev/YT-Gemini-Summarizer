import { getTranscriptForTab } from '../services/youtube-service.js';
import {
  GEM_URL,
  GEMINI_APP_URL,
  buildShortPrompt,
  buildExtendedPrompt,
  buildCriticalPrompt
} from '../config/prompts.js';

// DOM Elements
const summarizeShortBtn = document.getElementById('summarizeShortBtn');
const summarizeExtendedBtn = document.getElementById('summarizeExtendedBtn');
const criticalAnalysisBtn = document.getElementById('criticalAnalysisBtn');

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

let lastUsedMode = 'extended';
let currentFullPrompt = '';

// Initialize Side Panel
document.addEventListener('DOMContentLoaded', async () => {
  // Limpiar claves obsoletas de storage si existieran
  try {
    await chrome.storage.local.remove(['geminiApiKey', 'selectedModel', 'geminiTabId', 'pendingPrompt']);
  } catch (e) { /* noop */ }

  setupEventListeners();
});

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
  summarizeShortBtn.addEventListener('click', () => handleSummarizeClick('short'));
  summarizeExtendedBtn.addEventListener('click', () => handleSummarizeClick('extended'));
  criticalAnalysisBtn.addEventListener('click', () => handleSummarizeClick('critical'));

  retryBtn.addEventListener('click', () => handleSummarizeClick(lastUsedMode));

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
 * Manejador principal de extracción y envío según el modo seleccionado.
 * @param {'short' | 'extended' | 'critical'} mode
 */
async function handleSummarizeClick(mode) {
  lastUsedMode = mode;

  // Validar si el Gem de análisis crítico está configurado
  if (mode === 'critical' && (!GEM_URL || !GEM_URL.trim())) {
    showError('Configura la URL de tu Gem en src/config/prompts.js para usar el análisis crítico.');
    return;
  }

  const targetUrl = mode === 'critical' ? GEM_URL.trim() : GEMINI_APP_URL.trim();

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
    showError('La pestaña activa no es un reproductor de video de YouTube. Abre un video para resumirlo.');
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

  // 3. Construir el prompt según el modo seleccionado
  let fullPrompt = '';
  if (mode === 'short') {
    fullPrompt = buildShortPrompt(transcriptResponse.title, transcriptResponse.transcript);
  } else if (mode === 'critical') {
    fullPrompt = buildCriticalPrompt(transcriptResponse.title, transcriptResponse.transcript);
  } else {
    fullPrompt = buildExtendedPrompt(transcriptResponse.title, transcriptResponse.transcript);
  }

  currentFullPrompt = fullPrompt;

  // 4. Copiar prompt completo al portapapeles
  try {
    await navigator.clipboard.writeText(fullPrompt);
  } catch (e) {
    console.warn('[sidepanel] Error al copiar al portapapeles:', e);
  }

  // 5. Actualizar pasos de carga
  stepTranscript.classList.remove('active');
  stepGemini.classList.add('active');

  // 6. Abrir SIEMPRE una nueva pestaña de Gemini y registrar el prompt asociado a su tabId
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
        mode,
        createdAt: now
      };

      await chrome.storage.local.set({ pendingPrompts });
    }

    // Cerrar únicamente el widget/side panel lateral (manteniendo la pestaña de YouTube abierta)
    setTimeout(() => {
      window.close();
    }, 100);

  } catch (e) {
    console.error('[sidepanel] Error al abrir pestaña de Gemini:', e);
  }

  // 7. Actualizar texto de estado de éxito (por si window.close se demorase)
  videoTitleDisplay.textContent = transcriptResponse.title;
  metaLang.textContent = `Idioma: ${transcriptResponse.language || 'Auto'}`;
  metaWords.textContent = `~${transcriptResponse.wordCount || 0} palabras`;

  const modeLabels = {
    short: 'Resumen corto',
    extended: 'Resumen extendido',
    critical: 'Análisis crítico'
  };
  if (noticeTitle) {
    noticeTitle.textContent = `✨ Enviado a Gemini (${modeLabels[mode] || mode})`;
  }

  showState('success');
}

// Display Error UI State
function showError(message) {
  errorMessageText.textContent = message;
  showState('error');
}
