// Service worker entry point: wires chrome.* APIs to the controller.

import { createController, type TabAccess } from './controller.ts';
import { isContentReport, isPageObservation, isUiRequest, type ContentCommand, type InsertResult } from '../shared/messages.ts';
import { createLogger } from '../shared/logger.ts';
import { loadWorkflow } from '../shared/storage.ts';
import type { WorkflowState } from '../shared/types.ts';

const log = createLogger('background');
const CHATGPT_PATTERNS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

export function isChatgptUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'chatgpt.com' || hostname === 'chat.openai.com');
  } catch {
    return false;
  }
}

const tabs: TabAccess = {
  async findTargetTab(preferredTabId) {
    if (preferredTabId !== null) {
      try {
        const tab = await chrome.tabs.get(preferredTabId);
        if (isChatgptUrl(tab.url)) return preferredTabId;
      } catch {
        // The tab is gone; fall through to the active tab.
      }
    }
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined && isChatgptUrl(active.url)) return active.id;
    // Otherwise use the only ChatGPT tab, or the only one that is visible in its window.
    // With several candidates, refuse rather than guess which conversation is meant.
    const all = await chrome.tabs.query({ url: CHATGPT_PATTERNS });
    if (all.length === 1) return all[0]?.id ?? null;
    const visible = all.filter((tab) => tab.active);
    return visible.length === 1 ? visible[0]?.id ?? null : null;
  },
  async anyChatgptTab() {
    return (await chrome.tabs.query({ url: CHATGPT_PATTERNS })).length > 0;
  },
  async getObservation(tabId) {
    const command: ContentCommand = { type: 'GET_OBSERVATION' };
    const response: unknown = await chrome.tabs.sendMessage(tabId, command);
    return isPageObservation(response) ? response : null;
  },
  async insert(tabId, text, overwrite) {
    const command: ContentCommand = { type: 'INSERT_PROMPT', text, overwrite };
    const response = (await chrome.tabs.sendMessage(tabId, command)) as InsertResult | undefined;
    return response ?? { ok: false, error: 'The ChatGPT tab did not answer.' };
  },
};

const BADGES: Record<string, { text: string; color: string; title: string }> = {
  needs_review: { text: 'DONE', color: '#1a7f37', title: 'Response appears complete. Review it.' },
  generating: { text: '…', color: '#0969da', title: 'ChatGPT is generating' },
  paused: { text: 'II', color: '#9a6700', title: 'Monitoring paused' },
  limit: { text: '!', color: '#cf222e', title: 'Usage limit message shown' },
};

async function updateBadge(state: WorkflowState): Promise<void> {
  let badge: (typeof BADGES)[string] | null = null;
  if (state.monitoring === 'paused') badge = state.pauseReason === 'usage_limit' ? BADGES.limit! : BADGES.paused!;
  else if (state.monitoring === 'active' && state.phase === 'needs_review') badge = BADGES.needs_review!;
  else if (state.monitoring === 'active' && state.responseStatus === 'generating') badge = BADGES.generating!;
  try {
    await chrome.action.setBadgeText({ text: badge?.text ?? '' });
    if (badge) await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    await chrome.action.setTitle({ title: badge ? `ChatGPT Project Autopilot — ${badge.title}` : 'ChatGPT Project Autopilot' });
  } catch (error) {
    log.warn('Badge update failed', error);
  }
}

const controller = createController({
  storage: chrome.storage.local,
  tabs,
  now: () => Date.now(),
  log,
  onStateChange: updateBadge,
  async notify(effect) {
    await chrome.notifications.create(effect.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: effect.title,
      message: effect.message,
      priority: effect.kind === 'response_complete' ? 1 : 2,
    });
  },
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Extension pages (popup, side panel — also when opened in a tab) send UI requests;
  // content scripts on ChatGPT send page observations. Nothing else is accepted.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL('')) === true;
  if (!fromExtensionPage) {
    if (sender.tab?.id !== undefined && isContentReport(message) && isChatgptUrl(sender.url ?? sender.tab.url)) {
      void controller.handleContent(sender.tab.id, message);
    }
    return false;
  }
  if (isUiRequest(message)) {
    controller.handleUi(message).then(sendResponse, (error: unknown) => {
      log.error('UI request failed', error);
      sendResponse({ ok: false, error: 'The extension could not process the request.' });
    });
    return true; // keep the channel open for the async response
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => void controller.handleTabRemoved(tabId));
chrome.runtime.onStartup.addListener(() => void controller.handleStartup());

chrome.notifications.onClicked.addListener((notificationId) => {
  void (async () => {
    const state = await loadWorkflow(chrome.storage.local);
    if (state.trackedTabId !== null) {
      try {
        const tab = await chrome.tabs.update(state.trackedTabId, { active: true });
        if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        // The tab no longer exists.
      }
    }
    await chrome.notifications.clear(notificationId);
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch((error: unknown) => log.warn('Side panel setup failed', error));
  void loadWorkflow(chrome.storage.local).then(updateBadge);
});
