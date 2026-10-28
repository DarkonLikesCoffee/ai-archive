// Message contracts between the UI, the background service worker and the
// content script. Every message is validated on receipt.

import type { HandoffMethod } from './workflow.ts';
import type { PageObservation, ProjectSettings, ReviewOutcome, SettingsStore, ValidationResult, WorkflowState } from './types.ts';

/** UI -> background */
export type UiRequest =
  | { type: 'GET_SNAPSHOT' }
  | { type: 'SAVE_PROJECT'; project: ProjectSettings }
  | { type: 'CREATE_PROJECT' }
  | { type: 'DELETE_PROJECT'; projectId: string }
  | { type: 'SELECT_PROJECT'; projectId: string }
  | { type: 'START_SESSION' }
  | { type: 'RECORD_HANDOFF'; method: 'copy' }
  | { type: 'INSERT_PROMPT'; overwrite?: boolean }
  | { type: 'MARK_REVIEWED'; outcome: ReviewOutcome }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'RESET' }
  | { type: 'REFRESH_STATUS' };

export interface UiSnapshot {
  settings: SettingsStore;
  settingsRecovered: boolean;
  workflow: WorkflowState;
  validation: ValidationResult | null;
  /** Rendered continuation prompt for the next cycle, or null when it cannot be rendered. */
  prompt: { text: string; errors: string[]; warnings: string[]; cycle: number } | null;
  /** Whether a ChatGPT tab exists that the prompt could be inserted into. */
  chatgptTabAvailable: boolean;
}

export type UiResponse =
  | { ok: true; snapshot: UiSnapshot; note?: string }
  | { ok: false; error: string; code?: string; snapshot?: UiSnapshot };

/** content -> background */
export type ContentReport =
  | { type: 'PAGE_OBSERVATION'; observation: PageObservation }
  | { type: 'CONTENT_READY'; observation: PageObservation };

/** background -> content */
export type ContentCommand =
  | { type: 'INSERT_PROMPT'; text: string; overwrite?: boolean }
  | { type: 'GET_OBSERVATION' };

export type InsertResult =
  | { ok: true; verified: boolean }
  | { ok: false; error: string; code?: string };

export type { HandoffMethod };

const UI_TYPES = new Set<UiRequest['type']>([
  'GET_SNAPSHOT', 'SAVE_PROJECT', 'CREATE_PROJECT', 'DELETE_PROJECT', 'SELECT_PROJECT', 'START_SESSION',
  'RECORD_HANDOFF', 'INSERT_PROMPT', 'MARK_REVIEWED', 'PAUSE', 'RESUME', 'STOP', 'RESET', 'REFRESH_STATUS',
]);

export function isUiRequest(value: unknown): value is UiRequest {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && UI_TYPES.has(type as UiRequest['type']);
}

const STATUS_VALUES = new Set(['unknown', 'idle', 'generating', 'complete', 'error', 'usage_limit']);

export function isPageObservation(value: unknown): value is PageObservation {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.status === 'string' && STATUS_VALUES.has(o.status) &&
    (o.responseKey === null || typeof o.responseKey === 'string') &&
    typeof o.url === 'string' &&
    !!o.signals && typeof o.signals === 'object'
  );
}

export function isContentReport(value: unknown): value is ContentReport {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (r.type === 'PAGE_OBSERVATION' || r.type === 'CONTENT_READY') && isPageObservation(r.observation);
}
