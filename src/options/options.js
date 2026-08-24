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
document.addEventListener('DOMContentLoaded', loadActions);

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
    actionsList.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No tienes acciones configuradas.</p>';
    return;
  }

  acciones.forEach((acc, index) => {
    const item = document.createElement('div');
    item.className = `action-item ${editingId === acc.id ? 'active' : ''}`;
    
    item.innerHTML = `
      <div class="action-info">
        <span class="action-icon">${acc.icono || '⚡'}</span>
        <span class="action-title">${acc.nombre}</span>
      </div>
      <div class="action-controls">
        <button type="button" title="Subir" data-action="up" data-index="${index}" ${index === 0 ? 'disabled style="opacity:0.3;"' : ''}>▲</button>
        <button type="button" title="Bajar" data-action="down" data-index="${index}" ${index === acciones.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>▼</button>
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
      actionPromptInput.value = `Analiza la transcripción del vídeo de YouTube que va debajo aplicando tu método habitual. No te presentes ni me preguntes qué analizar: el material es este texto.

Título: {{titulo}}
URL: {{url}}

TRANSCRIPCIÓN:
{{transcripcion}}`;
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
    nombre: 'Nueva acción',
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
  showToast('Acción guardada correctamente.', 'success');
  renderList();
});

// Delete
document.getElementById('deleteBtn').addEventListener('click', async () => {
  const id = actionIdInput.value;
  if (confirm('¿Seguro que quieres eliminar esta acción?')) {
    acciones = acciones.filter(a => a.id !== id);
    await saveActions();
    closeEditor();
    showToast('Acción eliminada.', 'success');
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
    showToast('No hay acciones para exportar.', 'error');
    return;
  }
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(acciones, null, 2));
  const downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute("href", dataStr);
  downloadAnchorNode.setAttribute("download", "youtube-gemini-acciones.json");
  document.body.appendChild(downloadAnchorNode); // required for firefox
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
      if (!Array.isArray(imported)) throw new Error('El archivo no contiene un array válido.');
      
      // Basic validation
      const valid = imported.every(a => a.id && a.nombre && a.destino && a.prompt);
      if (!valid) throw new Error('El formato de las acciones importadas no es correcto.');

      acciones = imported;
      await saveActions();
      closeEditor();
      showToast('Acciones importadas correctamente.', 'success');
    } catch (err) {
      showToast('Error al importar: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset
});

document.getElementById('restoreBtn').addEventListener('click', async () => {
  if (confirm('¿Seguro que quieres restaurar las acciones por defecto? Esto sobreescribirá tus acciones actuales.')) {
    await chrome.storage.local.remove('acciones');
    // Call the background worker to re-seed? The easiest is to just re-seed directly here.
    const defaultActions = [
      {
        id: crypto.randomUUID(),
        nombre: 'Resumen corto',
        icono: '⚡',
        destino: 'app',
        prompt: 'Por favor, elabora un resumen breve en español de aproximadamente 8 a 10 líneas de la transcripción del siguiente vídeo de YouTube titulado "{{titulo}}".\n\nEscribe el resumen en prosa corrida, en un único bloque de texto sin encabezados, sin viñetas y sin introducciones ni preámbulos. Céntrate únicamente en extraer el contenido esencial del vídeo.\n\n---\n\nTRANSCRIPCIÓN COMPLETA:\n{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Resumen extendido',
        icono: '📋',
        destino: 'app',
        prompt: 'Por favor, analiza la siguiente transcripción del vídeo de YouTube titulado "{{titulo}}" y genera:\n\n1. Un resumen ejecutivo (3-4 frases).\n2. Los 5-7 puntos clave con viñetas explicativas.\n3. Conclusiones o \'takeaways\' accionables.\n\nFormatea todo con Markdown claro utilizando encabezados H2 y H3, y negrita para los conceptos importantes.\n\n---\n\nTRANSCRIPCIÓN COMPLETA:\n{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Preguntar al vídeo',
        icono: '💬',
        destino: 'app',
        prompt: 'Título del vídeo: "{{titulo}}"\n\nTranscripción:\n{{transcripcion}}\n\nConfirma en una sola línea que has leído la transcripción y que estás listo para responder preguntas. No resumas nada todavía ni añadas ninguna otra información.'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Datos y referencias',
        icono: '🔢',
        destino: 'app',
        prompt: 'A partir del vídeo "{{titulo}}" y la siguiente transcripción, extrae únicamente la información verificable que se cite explícitamente: cifras y estadísticas, estudios o fuentes, nombres propios, libros, herramientas y enlaces mencionados.\n\nPreséntalo en una lista, indicando claramente si alguna afirmación importante carece de fuente citada en el vídeo. No incluyas opiniones ni resúmenes.\n\nTranscripción:\n{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Copiar transcripción',
        icono: '📄',
        destino: 'portapapeles',
        prompt: '{{transcripcion}}'
      },
      {
        id: crypto.randomUUID(),
        nombre: 'Índice con minutos',
        icono: '🕒',
        destino: 'app',
        prompt: 'A continuación tienes la transcripción del vídeo "{{titulo}}" con marcas de tiempo. Crea un índice de secciones para el vídeo, indicando el minuto de inicio y una frase de descripción para cada sección. Añade además al final de cada ítem del índice un enlace con este formato exacto para que yo pueda hacer clic y saltar a ese momento del vídeo: {{url}}&t=SEGUNDOSs (sustituyendo SEGUNDOS por los segundos totales, por ejemplo &t=125s).\n\nTranscripción:\n{{transcripcion_con_tiempos}}'
      }
    ];
    acciones = defaultActions;
    await saveActions();
    closeEditor();
    showToast('Acciones restauradas por defecto.', 'success');
  }
});

function showToast(message, type) {
  toastMessage.textContent = message;
  toastMessage.className = `toast ${type}`;
  setTimeout(() => {
    toastMessage.className = 'toast';
  }, 4000);
}
