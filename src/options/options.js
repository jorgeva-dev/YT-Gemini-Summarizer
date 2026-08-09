import { testGeminiApiKey } from '../services/gemini-api.js';

const apiKeyInput = document.getElementById('apiKeyInput');
const toggleVisibilityBtn = document.getElementById('toggleVisibilityBtn');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const toastMessage = document.getElementById('toastMessage');

document.addEventListener('DOMContentLoaded', async () => {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  if (result.geminiApiKey) {
    apiKeyInput.value = result.geminiApiKey;
  }
});

// Toggle password visibility
toggleVisibilityBtn.addEventListener('click', () => {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleVisibilityBtn.textContent = '🔒';
  } else {
    apiKeyInput.type = 'password';
    toggleVisibilityBtn.textContent = '👁️';
  }
});

// Save settings
saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  
  if (!key) {
    showToast('Por favor, ingresa una API Key válida.', 'error');
    return;
  }

  await chrome.storage.local.set({ geminiApiKey: key });
  showToast('¡API Key guardada correctamente!', 'success');
});

// Test API Key connection
testBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showToast('Ingresa una API Key para probar la conexión.', 'error');
    return;
  }

  testBtn.textContent = 'Probando...';
  testBtn.disabled = true;

  try {
    const isValid = await testGeminiApiKey(key);
    if (isValid) {
      showToast('✅ Conexión exitosa con Google Gemini API.', 'success');
    } else {
      showToast('❌ Error de conexión. Verifica que la API Key sea correcta.', 'error');
    }
  } catch (err) {
    showToast('❌ Error al probar la conexión: ' + err.message, 'error');
  } finally {
    testBtn.textContent = 'Probar Conexión';
    testBtn.disabled = false;
  }
});

function showToast(message, type) {
  toastMessage.textContent = message;
  toastMessage.className = `toast ${type}`;
  setTimeout(() => {
    toastMessage.className = 'toast';
  }, 4000);
}
