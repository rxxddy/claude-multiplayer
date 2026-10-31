import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import en from './locales/en';
import it from './locales/it';

/**
 * UI translations.
 * To add a language: create src/i18n/locales/<code>.js (copy en.js, translate the values) and register it
 * in LANGUAGES below. Missing keys fall back to English, so a partial translation never breaks the UI.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', dict: en },
  { code: 'it', name: 'Italiano', dict: it },
];

const DICTS = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.dict]));
const listeners = new Set();
let current = 'en';

export function detectLanguage(saved) {
  const pick = (code) => (code && DICTS[code.toLowerCase().slice(0, 2)] ? code.toLowerCase().slice(0, 2) : null);
  return pick(saved) || pick(navigator.language) || (navigator.languages || []).map(pick).find(Boolean) || 'en';
}

export function initLanguage(saved) {
  current = detectLanguage(saved);
  document.documentElement.lang = current;
  listeners.forEach((fn) => fn());
}

export function getLanguage() {
  return current;
}

export async function setLanguage(code) {
  if (!DICTS[code]) return;
  current = code;
  document.documentElement.lang = code;
  listeners.forEach((fn) => fn());
  await invoke('set_language', { language: code }).catch(() => {});
}

/** t('key', { n: 3 }) → string with {n} placeholders filled. */
export function t(key, vars) {
  let s = DICTS[current]?.[key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

/** Re-renders the component when the language changes; returns t. */
export function useT() {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current
  );
  return t;
}

// ---------------- machine translation of other people's task titles ----------------
// Tasks are always written in English by Claude Code; translate them for the reader (cached, batched).
const cache = new Map(); // `${lang}|${text}` -> translated | null (failed)
const pending = new Set();
const textListeners = new Set();
let timer = null;

function flush() {
  timer = null;
  const lang = current;
  const texts = [...pending].filter((x) => !cache.has(`${lang}|${x}`));
  pending.clear();
  if (!texts.length || lang === 'en') return;
  invoke('translate_texts', { texts, target: lang })
    .then((res) => {
      for (const x of texts) cache.set(`${lang}|${x}`, res?.[x] ?? null);
      textListeners.forEach((fn) => fn());
    })
    .catch(() => texts.forEach((x) => cache.set(`${lang}|${x}`, null)));
}

/** Returns the task text translated into the UI language (original until the translation arrives). */
export function useTranslatedText(text) {
  const lang = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      textListeners.add(fn);
      return () => {
        listeners.delete(fn);
        textListeners.delete(fn);
      };
    },
    () => `${current}:${cache.size}`
  ).split(':')[0];
  const src = String(text || '').trim();
  if (!src || lang === 'en') return text;
  const key = `${lang}|${src}`;
  if (cache.has(key)) return cache.get(key) || text;
  if (!pending.has(src)) {
    pending.add(src);
    if (!timer) timer = setTimeout(flush, 300);
  }
  return text;
}
