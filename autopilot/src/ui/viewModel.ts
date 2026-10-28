// Pure mapping from a background snapshot to what the panel shows and which
// actions are enabled. Kept free of DOM access so it can be unit-tested.

import type { UiSnapshot } from '../shared/messages.ts';
import { activeProject } from '../shared/settings.ts';
import type { ResponseStatus, ReviewOutcome } from '../shared/types.ts';
import { STATUS_TEXT, STOP_REASON_TEXT } from '../shared/workflow.ts';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface DashboardModel {
  hasProject: boolean;
  projectName: string;
  milestone: string;
  configValid: boolean;
  configProblems: string[];
  observed: { status: string; tone: Tone; updated: string; scope: string };
  workflow: { monitoring: string; monitoringTone: Tone; cycle: string; phase: string; lastContinuation: string; stopReason: string };
  reported: { outcome: string };
  nextStep: string;
  prompt: { text: string; cycleLabel: string; errors: string[]; warnings: string[] };
  actions: {
    start: boolean;
    copy: boolean;
    insert: boolean;
    review: boolean;
    pause: boolean;
    resume: boolean;
    stop: boolean;
    reset: boolean;
  };
  /** True when the next copy/insert would start a new cycle (so confirmation applies). */
  handoffStartsCycle: boolean;
  requireConfirmation: boolean;
  recoveredNotice: string | null;
}

const STATUS_TONE: Record<ResponseStatus, Tone> = {
  unknown: 'neutral',
  idle: 'neutral',
  generating: 'info',
  complete: 'success',
  error: 'danger',
  usage_limit: 'danger',
};

export const OUTCOME_TEXT: Record<ReviewOutcome, string> = {
  continue: 'Continue (ChatGPT reported more work remaining)',
  milestone_reported: 'Milestone met (as reported by ChatGPT, not verified by the extension)',
  blocker_reported: 'Blocked (ChatGPT reported a blocker needing your input)',
};

export function formatTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  const clock = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (seconds < 60) return `${clock} (just now)`;
  if (seconds < 3600) return `${clock} (${Math.floor(seconds / 60)} min ago)`;
  return new Date(timestamp).toLocaleString();
}

export function buildDashboard(snapshot: UiSnapshot, now: number): DashboardModel {
  const project = activeProject(snapshot.settings);
  const wf = snapshot.workflow;
  const validation = snapshot.validation;
  const configValid = !!project && !!validation?.valid;
  const open = wf.monitoring === 'active' || wf.monitoring === 'paused';
  const active = wf.monitoring === 'active';
  const max = project?.maxCyclesPerSession ?? 0;
  const promptOk = !!snapshot.prompt && snapshot.prompt.errors.length === 0 && !!snapshot.prompt.text;

  const monitoring =
    wf.monitoring === 'paused'
      ? wf.pauseReason === 'usage_limit' ? 'Paused — usage-limit message seen' : 'Paused'
      : { inactive: 'Not started', active: 'Active', stopped: 'Stopped' }[wf.monitoring];
  const monitoringTone: Tone = wf.monitoring === 'active' ? 'success' : wf.monitoring === 'paused' ? 'warning' : 'neutral';

  const phase = !open
    ? '—'
    : { ready: 'Prompt prepared — waiting for you to hand it off', awaiting_response: 'Waiting for ChatGPT’s response', needs_review: 'Response appears complete — review it' }[wf.phase];

  let nextStep: string;
  if (!project) nextStep = 'Create a project in the Project tab.';
  else if (!configValid) nextStep = 'Complete the project settings (Project tab) before starting.';
  else if (wf.monitoring === 'inactive' || wf.monitoring === 'stopped') nextStep = 'Start a session to prepare the first continuation prompt.';
  else if (wf.monitoring === 'paused' && wf.pauseReason === 'usage_limit') nextStep = 'ChatGPT showed a usage-limit message. Wait until you can continue, then resume. Nothing is resent automatically.';
  else if (wf.monitoring === 'paused') nextStep = 'Monitoring is paused. Resume when you want completion notifications again.';
  else if (wf.phase === 'ready') nextStep = `Copy or insert prompt ${wf.cycle + 1}, check it in ChatGPT, then press Send yourself.`;
  else if (wf.phase === 'awaiting_response') nextStep = 'Waiting for ChatGPT. You will be notified when the response appears complete.';
  else nextStep = 'Read ChatGPT’s reply (and the AUTOPILOT STATUS line), then mark the cycle reviewed.';

  const observedScope = wf.trackedTabId !== null ? 'Tracked ChatGPT tab' : wf.conversationUrl ? 'Waiting for the tracked conversation to report' : 'Any open ChatGPT tab';

  return {
    hasProject: !!project,
    projectName: project?.projectName.trim() || (project ? 'Untitled project' : 'No project'),
    milestone: project?.milestone.trim() || '—',
    configValid,
    configProblems: validation?.errors.map((e) => e.message) ?? [],
    observed: {
      status: STATUS_TEXT[wf.responseStatus],
      tone: STATUS_TONE[wf.responseStatus],
      updated: formatTime(wf.lastEventAt, now),
      scope: observedScope,
    },
    workflow: {
      monitoring,
      monitoringTone,
      cycle: open || wf.cycle > 0 ? `${wf.cycle} of ${max}` : `0 of ${max}`,
      phase,
      lastContinuation: formatTime(wf.lastContinuationAt, now),
      stopReason: wf.stopReason ? STOP_REASON_TEXT[wf.stopReason] : '—',
    },
    reported: { outcome: wf.lastReviewOutcome ? OUTCOME_TEXT[wf.lastReviewOutcome] : '—' },
    nextStep,
    prompt: {
      text: snapshot.prompt?.text ?? '',
      cycleLabel: snapshot.prompt ? `Continuation ${snapshot.prompt.cycle}` : '',
      errors: snapshot.prompt?.errors ?? [],
      warnings: snapshot.prompt?.warnings ?? [],
    },
    actions: {
      start: configValid && promptOk && !open,
      copy: promptOk,
      insert: configValid && promptOk && active && wf.phase !== 'needs_review' && snapshot.chatgptTabAvailable,
      review: open && wf.phase !== 'ready',
      pause: active,
      resume: wf.monitoring === 'paused',
      stop: open,
      reset: wf.monitoring === 'stopped',
    },
    handoffStartsCycle: active && wf.phase === 'ready',
    requireConfirmation: project?.requireConfirmation ?? true,
    recoveredNotice:
      wf.recoveredFromCorruption || snapshot.settingsRecovered
        ? 'Some stored extension data was unreadable and was reset to safe defaults. Check your settings.'
        : null,
  };
}
