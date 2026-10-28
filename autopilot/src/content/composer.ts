// Puts text into the ChatGPT composer. It never presses Enter, never clicks
// the send control and never submits a form: the user sends the message.

import type { SelectorConfig } from './selectors.ts';
import { isVisible } from './page.ts';

export type InsertOutcome =
  | { ok: true; verified: boolean }
  | { ok: false; reason: 'no_composer' | 'composer_not_empty' | 'composer_disabled' | 'insert_failed' };

const normalize = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export function findComposer(doc: Document, selectors: SelectorConfig): HTMLElement | null {
  for (const selector of selectors.composer) {
    let candidates: HTMLElement[];
    try {
      candidates = Array.from(doc.querySelectorAll<HTMLElement>(selector));
    } catch {
      continue;
    }
    const match = candidates.find((el) => isVisible(el));
    if (match) return match;
  }
  return null;
}

function isTextArea(el: HTMLElement): el is HTMLTextAreaElement {
  return el.tagName === 'TEXTAREA';
}

export function composerText(el: HTMLElement): string {
  return isTextArea(el) ? el.value : el.innerText ?? el.textContent ?? '';
}

function setTextAreaValue(el: HTMLTextAreaElement, text: string): void {
  // Use the native setter so frameworks that track the value notice the change.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function insertIntoEditable(doc: Document, el: HTMLElement, text: string): void {
  el.focus();
  const selection = doc.getSelection();
  if (selection) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  // execCommand('insertText') goes through the editor's own input handling
  // (ProseMirror), which keeps its internal state consistent.
  let inserted = false;
  try {
    inserted = doc.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }
  if (!inserted || normalize(composerText(el)) !== normalize(text)) {
    // Fallback: a synthetic paste, which editors handle as user input.
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }
}

export function insertPrompt(doc: Document, selectors: SelectorConfig, text: string, overwrite: boolean): InsertOutcome {
  const el = findComposer(doc, selectors);
  if (!el) return { ok: false, reason: 'no_composer' };
  if (el.getAttribute('aria-disabled') === 'true' || (isTextArea(el) && el.disabled)) return { ok: false, reason: 'composer_disabled' };
  if (normalize(composerText(el)) && !overwrite) return { ok: false, reason: 'composer_not_empty' };

  if (isTextArea(el)) {
    el.focus();
    setTextAreaValue(el, text);
  } else {
    insertIntoEditable(doc, el, text);
  }
  const verified = normalize(composerText(el)) === normalize(text);
  return verified ? { ok: true, verified } : { ok: false, reason: 'insert_failed' };
}

export const INSERT_FAILURE_TEXT: Record<Exclude<InsertOutcome, { ok: true }>['reason'], string> = {
  no_composer: 'The ChatGPT message box was not found on this page. Use Copy prompt and paste it yourself.',
  composer_not_empty: 'The ChatGPT message box already contains text.',
  composer_disabled: 'The ChatGPT message box is disabled right now.',
  insert_failed: 'The prompt could not be placed in the message box reliably. Use Copy prompt and paste it yourself.',
};
