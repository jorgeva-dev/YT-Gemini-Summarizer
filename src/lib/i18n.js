/**
 * Internationalization (i18n) Helper
 * Replaces marked DOM elements with their localized chrome.i18n messages
 * and updates <html lang="..."> attribute.
 */
export function applyI18n(root = document) {
  // Update <html> lang attribute to match active UI language
  if (document.documentElement) {
    const uiLang = (chrome.i18n.getUILanguage() || 'en').split('-')[0];
    document.documentElement.lang = uiLang;
  }

  // data-i18n -> textContent
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) {
      el.textContent = msg;
    }
  });

  // data-i18n-placeholder -> placeholder attribute
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = chrome.i18n.getMessage(key);
    if (msg) {
      el.placeholder = msg;
    }
  });

  // data-i18n-title -> title attribute
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const msg = chrome.i18n.getMessage(key);
    if (msg) {
      el.title = msg;
    }
  });
}
