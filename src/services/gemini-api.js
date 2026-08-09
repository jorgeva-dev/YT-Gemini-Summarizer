/**
 * Gemini API Wrapper Service
 * Communicates directly with Google Generative Language REST API.
 */

const SYSTEM_PROMPT = `Eres un asistente de investigación de élite. Analiza la siguiente transcripción de un vídeo de YouTube y genera:
1. Un resumen ejecutivo (3-4 frases).
2. Los 5-7 puntos clave con viñetas explicativas.
3. Conclusiones o 'takeaways' accionables.

Formatea todo con Markdown claro utilizando encabezados H2 y H3. Utiliza negrita para conceptos importantes.`;

/**
 * Summarizes video transcript using Google Gemini API.
 * 
 * @param {string} apiKey - Google Gemini API Key
 * @param {string} videoTitle - Title of YouTube Video
 * @param {string} transcriptText - Raw text transcript
 * @param {string} [modelName='gemini-1.5-pro'] - Gemini Model ID
 * @returns {Promise<string>} Generated markdown summary text
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Summarizes video transcript using Google Gemini API.
 * 
 * @param {string} apiKey - Google Gemini API Key
 * @param {string} videoTitle - Title of YouTube Video
 * @param {string} transcriptText - Raw text transcript
 * @param {string} [modelName='gemini-2.0-flash'] - Gemini Model ID
 * @returns {Promise<string>} Generated markdown summary text
 */
export async function generateSummary(apiKey, videoTitle, transcriptText, modelName = 'gemini-2.0-flash') {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('No se ha configurado la API Key de Gemini. Ve a Opciones para guardarla.');
  }

  if (!transcriptText || !transcriptText.trim()) {
    throw new Error('La transcripción del video está vacía.');
  }

  // Lista de modelos a probar en orden por si el seleccionado devuelve 404/NOT_FOUND
  const candidateModels = [
    modelName,
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-1.5-flash-latest'
  ];
  // Eliminar duplicados y nulos
  const modelsToTry = [...new Set(candidateModels.filter(Boolean))];

  const promptText = `${SYSTEM_PROMPT}\n\nTítulo del Video: "${videoTitle}"\n\nTranscripción:\n${transcriptText}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: promptText
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.95,
      maxOutputTokens: 2048
    }
  };

  let lastError = null;
  let rateLimited = false;
  const MAX_ATTEMPTS = 3;

  for (const selectedModel of modelsToTry) {
    const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

    // Backoff por modelo ante rate limit (429) puntual. Si un modelo agota sus
    // reintentos se pasa al siguiente: cada modelo tiene su propia cuota.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorJson = await response.json().catch(() => null);
          const apiErrorMessage = errorJson?.error?.message;

          // Rate Limit (429): Google indica cuánto esperar en RetryInfo.
          if (response.status === 429) {
            rateLimited = true;
            lastError = new Error(apiErrorMessage || 'Rate limit (429).');

            if (attempt < MAX_ATTEMPTS) {
              const retryInfo = (errorJson?.error?.details || []).find((d) =>
                String(d['@type'] || '').includes('RetryInfo')
              );
              const suggested = retryInfo?.retryDelay
                ? parseFloat(String(retryInfo.retryDelay).replace('s', '')) * 1000
                : 0;
              // Backoff exponencial (2s, 4s) salvo que Google pida algo mayor.
              const waitMs = Math.min(Math.max(suggested || 0, 2000 * attempt), 15000);
              console.warn(`[gemini-api] 429 en ${selectedModel}; esperando ${waitMs}ms (intento ${attempt}/${MAX_ATTEMPTS})`);
              await sleep(waitMs);
              continue;
            }

            // Agotados los reintentos: probar el siguiente modelo (otra cuota).
            console.warn(`[gemini-api] ${selectedModel} sigue con 429, probando siguiente modelo...`);
            break;
          }

          // Si el modelo no existe (404), pasar al siguiente de la lista
          if (response.status === 404 || apiErrorMessage?.includes('is not found')) {
            console.warn(`[gemini-api] Modelo ${selectedModel} no encontrado en v1beta, probando siguiente candidato...`);
            lastError = new Error(apiErrorMessage || `Modelo ${selectedModel} no encontrado.`);
            break; // Rompe el bucle de intentos y pasa al siguiente modelo
          }

          if (response.status === 401 || response.status === 403) {
            throw new Error(`API Key inválida o sin permisos (HTTP ${response.status}). Revisa la clave en Opciones.`);
          } else if (response.status >= 500) {
            throw new Error(`Error en los servidores de Google Gemini (HTTP ${response.status}). Intenta más tarde.`);
          } else {
            throw new Error(apiErrorMessage || `Error HTTP ${response.status} de Gemini API.`);
          }
        }

        const data = await response.json();

        const candidate = data.candidates?.[0];
        if (!candidate || !candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
          if (candidate?.finishReason === 'SAFETY') {
            throw new Error('Gemini rechazó procesar el contenido debido a filtros de seguridad.');
          }
          throw new Error('Gemini no devolvió una respuesta válida.');
        }

        return candidate.content.parts[0].text;

      } catch (err) {
        if (
          err.message?.includes('API Key') ||
          err.message?.includes('servidores') ||
          err.message?.includes('filtros de seguridad')
        ) {
          throw err;
        }
        console.warn(`[gemini-api] Fallo intento ${attempt} con ${selectedModel}:`, err.message);
        lastError = err;
      }
    }
  }

  if (rateLimited) {
    throw new Error(
      'Todos los modelos de Gemini han devuelto 429 (límite de peticiones de tu API Key). ' +
      'Espera ~1 minuto e inténtalo de nuevo, o revisa tu cuota en aistudio.google.com.'
    );
  }

  throw lastError || new Error('No se pudo generar el resumen. Comprueba tu API Key y tu conexión.');
}

/**
 * Validates Gemini API key with a minimal test ping request.
 * 
 * @param {string} apiKey 
 * @returns {Promise<boolean>} True if valid
 */
export async function testGeminiApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) return false;

  const candidateModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash-latest'];
  const payload = {
    contents: [
      {
        parts: [{ text: "ping" }]
      }
    ]
  };

  for (const model of candidateModels) {
    const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) return true;
    } catch (e) {
      /* continue */
    }
  }

  return false;
}
