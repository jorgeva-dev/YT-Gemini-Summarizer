/**
 * CONFIGURACIÓN DE PROMPTS Y DESTINOS DE GEMINI
 * ============================================
 * Este archivo es el único lugar que necesitas editar para cambiar las URLs
 * de Gemini o personalizar los prompts que se envían para cada modo de resumen.
 */

// URL del Gem personalizado "investigador independiente CIENCIA".
// Para obtenerla: ve a gemini.google.com -> barra lateral -> clic en tu Gem -> copiar la URL del navegador.
export const GEM_URL = 'https://gemini.google.com/gem/976e26a49520';

// URL estándar de Gemini Web Chat.
export const GEMINI_APP_URL = 'https://gemini.google.com/app';

/**
 * 1. Resumen Corto (8-10 líneas en prosa corrida, sin encabezados ni viñetas).
 */
export function buildShortPrompt(title, transcript) {
  return `Por favor, elabora un resumen breve en español de aproximadamente 8 a 10 líneas de la transcripción del siguiente vídeo de YouTube titulado "${title}".

Escribe el resumen en prosa corrida, en un único bloque de texto sin encabezados, sin viñetas y sin introducciones ni preámbulos. Céntrate únicamente en extraer el contenido esencial del vídeo.

---

TRANSCRIPCIÓN COMPLETA:
${transcript}`;
}

/**
 * 2. Resumen Extendido (ejecutivo + 5-7 puntos clave + conclusiones en Markdown).
 */
export function buildExtendedPrompt(title, transcript) {
  return `Por favor, analiza la siguiente transcripción del vídeo de YouTube titulado "${title}" y genera:

1. Un resumen ejecutivo (3-4 frases).
2. Los 5-7 puntos clave con viñetas explicativas.
3. Conclusiones o 'takeaways' accionables.

Formatea todo con Markdown claro utilizando encabezados H2 y H3, y negrita para los conceptos importantes.

---

TRANSCRIPCIÓN COMPLETA:
${transcript}`;
}

/**
 * 3. Análisis Crítico (se envía únicamente la transcripción al Gem sin instrucciones extra).
 * IMPORTANTE: El Gem personalizado del usuario ya cuenta con su propio prompt maestro.
 * No se debe incluir ninguna instrucción de formato ni de análisis para evitar interferir.
 */
export function buildCriticalPrompt(title, transcript) {
  return `Transcripción del vídeo de YouTube "${title}":

${transcript}`;
}
