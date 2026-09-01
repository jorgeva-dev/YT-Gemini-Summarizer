/**
 * Default Actions Configuration
 * Generates the seeded default actions translated into the active UI language.
 */
export function getDefaultActions() {
  return [
    {
      id: crypto.randomUUID(),
      nombre: chrome.i18n.getMessage('actionShortSummaryName') || 'Resumen corto',
      icono: '⚡',
      destino: 'app',
      prompt: chrome.i18n.getMessage('actionShortSummaryPrompt') || ''
    },
    {
      id: crypto.randomUUID(),
      nombre: chrome.i18n.getMessage('actionExtendedSummaryName') || 'Resumen extendido',
      icono: '📋',
      destino: 'app',
      prompt: chrome.i18n.getMessage('actionExtendedSummaryPrompt') || ''
    },
    {
      id: crypto.randomUUID(),
      nombre: chrome.i18n.getMessage('actionAskVideoName') || 'Preguntar al vídeo',
      icono: '💬',
      destino: 'app',
      prompt: chrome.i18n.getMessage('actionAskVideoPrompt') || ''
    },
    {
      id: crypto.randomUUID(),
      nombre: chrome.i18n.getMessage('actionDataReferencesName') || 'Datos y referencias',
      icono: '🔢',
      destino: 'app',
      prompt: chrome.i18n.getMessage('actionDataReferencesPrompt') || ''
    },
    {
      id: crypto.randomUUID(),
      nombre: chrome.i18n.getMessage('actionCopyTranscriptName') || 'Copiar a portapapeles',
      icono: '📄',
      destino: 'portapapeles',
      prompt: chrome.i18n.getMessage('actionCopyTranscriptPrompt') || '{{transcripcion}}'
    },
    {
      id: crypto.randomUUID(),
      nombre: chrome.i18n.getMessage('actionIndexMinutesName') || 'Índice con minutos',
      icono: '🕒',
      destino: 'app',
      prompt: chrome.i18n.getMessage('actionIndexMinutesPrompt') || ''
    }
  ];
}
