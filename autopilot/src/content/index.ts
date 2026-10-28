// Content script for chatgpt.com. Observes page state, reports status changes
// to the background worker and inserts prompts on request. It does not read,
// store or send the text of any conversation message.

import { INSERT_FAILURE_TEXT, insertPrompt } from './composer.ts';
import { createDetector } from './detector.ts';
import { observePage } from './page.ts';
import { DEFAULT_SELECTORS } from './selectors.ts';
import type { ContentCommand, ContentReport, InsertResult } from '../shared/messages.ts';
import { createLogger } from '../shared/logger.ts';

const log = createLogger('content');

function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function start(): void {
  let observer: MutationObserver | null = null;

  const send = (report: ContentReport) => {
    if (!extensionAlive()) {
      shutdown();
      return;
    }
    chrome.runtime.sendMessage(report).catch((error: unknown) => {
      // "Extension context invalidated" after an update/reload: stop quietly.
      if (!extensionAlive()) shutdown();
      else log.warn('Could not report page status', error);
    });
  };

  const detector = createDetector({
    read: () => observePage(document, location.href, DEFAULT_SELECTORS),
    emit: (observation) => send({ type: 'PAGE_OBSERVATION', observation }),
    timers: { setTimeout: (cb, ms) => window.setTimeout(cb, ms), clearTimeout: (h) => window.clearTimeout(h as number) },
  });

  function shutdown() {
    observer?.disconnect();
    observer = null;
    detector.dispose();
  }

  observer = new MutationObserver(() => detector.schedule());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-testid', 'aria-label', 'aria-disabled', 'disabled', 'hidden', 'class', 'role'],
  });

  // ChatGPT is a single-page app: conversation switches do not reload the page.
  window.addEventListener('popstate', () => detector.schedule());
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', () => detector.schedule());
  document.addEventListener('visibilitychange', () => detector.schedule());

  chrome.runtime.onMessage.addListener((message: ContentCommand, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
    if (message.type === 'GET_OBSERVATION') {
      sendResponse(detector.current());
      return false;
    }
    if (message.type === 'INSERT_PROMPT' && typeof message.text === 'string') {
      const outcome = insertPrompt(document, DEFAULT_SELECTORS, message.text, message.overwrite === true);
      const result: InsertResult = outcome.ok
        ? { ok: true, verified: outcome.verified }
        : { ok: false, error: INSERT_FAILURE_TEXT[outcome.reason], code: outcome.reason };
      sendResponse(result);
      return false;
    }
    return false;
  });

  send({ type: 'CONTENT_READY', observation: detector.current() });
  detector.evaluate();
}

try {
  start();
} catch (error) {
  log.error('Autopilot content script failed to start', error);
}
