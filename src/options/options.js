import { applyI18n } from '../lib/i18n.js';
import { getDefaultActions } from '../config/default-actions.js';

let acciones = [];
let editingId = null;

// DOM Elements
const actionsList = document.getElementById('actionsList');
const emptyState = document.getElementById('emptyState');
const editForm = document.getElementById('editForm');

const actionIdInput = document.getElementById('actionId');
const actionNameInput = document.getElementById('actionName');
const actionIconInput = document.getElementById('actionIcon');
const actionDestSelect = document.getElementById('actionDest');
const actionGemUrlInput = document.getElementById('actionGemUrl');
const actionPromptInput = document.getElementById('actionPrompt');
const gemUrlGroup = document.getElementById('gemUrlGroup');
const toastMessage = document.getElementById('toastMessage');

// Init
document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  loadActions();
});

async function loadActions() {
  const data = await chrome.storage.local.get('acciones');
  acciones = data.acciones || [];
  renderList();
  
  if (editingId && !acciones.find(a => a.id === editingId)) {
    closeEditor();
  } else if (editingId) {
    const act = acciones.find(a => a.id === editingId);
    openEditor(act);
  }
}

function renderList() {
  actionsList.innerHTML = '';
  
  if (acciones.length === 0) {
    const noActionsText = chrome.i18n.getMessage('noActionsConfigured') || 'No tienes acciones configuradas.';
    actionsList.innerHTML = `<p style="color: var(--text-muted); font-size: 13px;">${noActionsText}</p>`;
    return;
  }

  const moveUpTitle = chrome.i18n.getMessage('btnMoveUpTitle') || 'Subir';
  const moveDownTitle = chrome.i18n.getMessage('btnMoveDownTitle') || 'Bajar';

  acciones.forEach((acc, index) => {
    const item = document.createElement('div');
    item.className = `action-item ${editingId === acc.id ? 'active' : ''}`;
    
    item.innerHTML = `
      <div class="action-info">
        <span class="action-icon">${acc.icono || '⚡'}</span>
        <span class="action-title">${acc.nombre}</span>
      </div>
      <div class="action-controls">
        <button type="button" title="${moveUpTitle}" data-action="up" data-index="${index}" ${index === 0 ? 'disabled style="opacity:0.3;"' : ''}>▲</button>
        <button type="button" title="${moveDownTitle}" data-action="down" data-index="${index}" ${index === acciones.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>▼</button>
      </div>
    `;

    // Click on item to edit
    item.addEventListener('click', (e) => {
      // Ignore if clicking on up/down buttons
      if (e.target.tagName.toLowerCase() === 'button') return;
      openEditor(acc);
    });

    // Handle up/down
    item.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const i = parseInt(btn.dataset.index);
        
        if (action === 'up' && i > 0) {
          [acciones[i - 1], acciones[i]] = [acciones[i], acciones[i - 1]];
          saveActions();
        } else if (action === 'down' && i < acciones.length - 1) {
          [acciones[i + 1], acciones[i]] = [acciones[i], acciones[i + 1]];
          saveActions();
        }
      });
    });

    actionsList.appendChild(item);
  });
}

function openEditor(acc) {
  editingId = acc.id;
  
  // Update UI selection
  document.querySelectorAll('.action-item').forEach(el => el.classList.remove('active'));
  renderList(); // re-render to set active class properly
  
  emptyState.classList.add('hidden');
  editForm.classList.remove('hidden');

  actionIdInput.value = acc.id;
  actionNameInput.value = acc.nombre || '';
  actionIconInput.value = acc.icono || '';
  actionDestSelect.value = acc.destino || 'app';
  actionGemUrlInput.value = acc.gemUrl || '';
  actionPromptInput.value = acc.prompt || '';
  
  toggleGemUrlVisibility();
}

function closeEditor() {
  editingId = null;
  renderList();
  emptyState.classList.remove('hidden');
  editForm.classList.add('hidden');
}

// Toggle Gem URL field and handle prompt template
actionDestSelect.addEventListener('change', () => {
  toggleGemUrlVisibility();
  if (actionDestSelect.value === 'gem') {
    const currentPrompt = actionPromptInput.value.trim();
    if (currentPrompt === '' || currentPrompt === '{{transcripcion}}') {
      actionPromptInput.value = chrome.i18n.getMessage('gemDefaultPrompt') || `Analiza la transcripción del vídeo de YouTube que va debajo aplicando tu método habitual. No te presentes ni me preguntes qué analizar: el material es este texto.\n\nTítulo: {{titulo}}\nURL: {{url}}\n\nTRANSCRIPCIÓN:\n{{transcripcion}}`;
    }
  }
});

function toggleGemUrlVisibility() {
  if (actionDestSelect.value === 'gem') {
    gemUrlGroup.classList.remove('hidden');
    actionGemUrlInput.required = true;
  } else {
    gemUrlGroup.classList.add('hidden');
    actionGemUrlInput.required = false;
  }
}

// New Action
document.getElementById('newActionBtn').addEventListener('click', () => {
  const newAction = {
    id: crypto.randomUUID(),
    nombre: chrome.i18n.getMessage('newActionDefaultName') || 'Nueva acción',
    icono: '✨',
    destino: 'app',
    prompt: '{{transcripcion}}'
  };
  acciones.push(newAction);
  saveActions().then(() => {
    openEditor(newAction);
  });
});

// Save Form
editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const id = actionIdInput.value;
  const index = acciones.findIndex(a => a.id === id);
  if (index === -1) return;

  acciones[index] = {
    id: id,
    nombre: actionNameInput.value.trim(),
    icono: actionIconInput.value.trim(),
    destino: actionDestSelect.value,
    gemUrl: actionDestSelect.value === 'gem' ? actionGemUrlInput.value.trim() : undefined,
    prompt: actionPromptInput.value
  };

  await saveActions();
  showToast(chrome.i18n.getMessage('toastActionSaved') || 'Acción guardada correctamente.', 'success');
  renderList();
});

// Delete
document.getElementById('deleteBtn').addEventListener('click', async () => {
  const id = actionIdInput.value;
  const confirmMsg = chrome.i18n.getMessage('confirmDeleteAction') || '¿Seguro que quieres eliminar esta acción?';
  if (confirm(confirmMsg)) {
    acciones = acciones.filter(a => a.id !== id);
    await saveActions();
    closeEditor();
    showToast(chrome.i18n.getMessage('toastActionDeleted') || 'Acción eliminada.', 'success');
  }
});

// Save to storage
async function saveActions() {
  await chrome.storage.local.set({ acciones });
  renderList();
}

// Import / Export / Restore
document.getElementById('exportBtn').addEventListener('click', () => {
  if (acciones.length === 0) {
    showToast(chrome.i18n.getMessage('toastNoActionsExport') || 'No hay acciones para exportar.', 'error');
    return;
  }
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(acciones, null, 2));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "youtube-gemini-acciones.json");
  document.body.appendChild(downloadAnchorNode);
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (!Array.isArray(imported)) {
        throw new Error(chrome.i18n.getMessage('errorImportNotArray') || 'El archivo no contiene un array válido.');
      }
      
      // Basic validation
      const valid = imported.every(a => a.id && a.nombre && a.destino && a.prompt);
      if (!valid) {
        throw new Error(chrome.i18n.getMessage('errorImportInvalidFormat') || 'El formato de las acciones importadas no es correcto.');
      }

      acciones = imported;
      await saveActions();
      closeEditor();
      showToast(chrome.i18n.getMessage('toastImportSuccess') || 'Acciones importadas correctamente.', 'success');
    } catch (err) {
      const errMsg = chrome.i18n.getMessage('toastImportError', [err.message]) || ('Error al importar: ' + err.message);
      showToast(errMsg, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset
});

document.getElementById('restoreBtn').addEventListener('click', async () => {
  const confirmMsg = chrome.i18n.getMessage('confirmRestoreDefaults') || '¿Seguro que quieres restaurar las acciones por defecto? Esto sobreescribirá tus acciones actuales.';
  if (confirm(confirmMsg)) {
    acciones = getDefaultActions();
    await saveActions();
    closeEditor();
    showToast(chrome.i18n.getMessage('toastActionsRestored') || 'Acciones restauradas por defecto.', 'success');
  }
});

function showToast(message, type) {
  toastMessage.textContent = message;
  toastMessage.className = `toast ${type}`;
  setTimeout(() => {
    toastMessage.className = 'toast';
  }, 4000);
}
