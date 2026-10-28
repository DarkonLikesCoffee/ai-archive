// Persistence over chrome.storage.local. The storage area is injected so the
// logic can be tested without a browser.

import { normalizeSettingsStore } from './settings.ts';
import type { SettingsStore, WorkflowState } from './types.ts';
import { normalizeWorkflowState } from './workflow.ts';

export const SETTINGS_KEY = 'autopilot.settings';
export const WORKFLOW_KEY = 'autopilot.workflow';

export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LoadedSettings {
  store: SettingsStore;
  recovered: boolean;
}

export async function loadSettings(area: StorageAreaLike): Promise<LoadedSettings> {
  const data = await area.get(SETTINGS_KEY);
  return normalizeSettingsStore(data[SETTINGS_KEY]);
}

export async function saveSettings(area: StorageAreaLike, store: SettingsStore): Promise<void> {
  await area.set({ [SETTINGS_KEY]: store });
}

export async function loadWorkflow(area: StorageAreaLike): Promise<WorkflowState> {
  const data = await area.get(WORKFLOW_KEY);
  return normalizeWorkflowState(data[WORKFLOW_KEY]);
}

export async function saveWorkflow(area: StorageAreaLike, state: WorkflowState): Promise<void> {
  await area.set({ [WORKFLOW_KEY]: state });
}

/**
 * Runs read-modify-write operations one at a time. The service worker can
 * receive several messages at once (observations, UI clicks); without this
 * two of them could read the same state and one update would be lost.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
