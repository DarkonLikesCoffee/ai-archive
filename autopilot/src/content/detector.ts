// Turns a stream of page reads into deduplicated status reports.
//
// Mutations are coalesced, and the end of a generation is only reported once
// the page has stayed out of the generating state for a short confirmation
// window and a fresh read agrees. The window does not assume how long a
// response takes; it only filters the brief flicker between streaming chunks
// and UI re-renders. Every report is based on a read of the live page.

import type { PageObservation } from '../shared/types.ts';

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DetectorOptions {
  read: () => PageObservation;
  emit: (observation: PageObservation) => void;
  timers: Timers;
  /** How long the page must stay out of "generating" before the end is reported. */
  settleMs?: number;
  /** Coalescing window for bursts of DOM mutations. */
  coalesceMs?: number;
}

export interface Detector {
  /** Call on every DOM mutation or navigation; reads are coalesced. */
  schedule(): void;
  /** Reads the page now and reports if the status changed. */
  evaluate(): void;
  /** The most recent read (for direct queries from the background). */
  current(): PageObservation;
  /** Forgets the last report so the next evaluation is sent again. */
  resetReported(): void;
  dispose(): void;
}

export const DEFAULT_SETTLE_MS = 1500;
export const DEFAULT_COALESCE_MS = 150;

export function sameReport(a: PageObservation | null, b: PageObservation): boolean {
  return !!a && a.status === b.status && a.responseKey === b.responseKey && a.url === b.url;
}

export function createDetector(options: DetectorOptions): Detector {
  const { read, emit, timers } = options;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  let reported: PageObservation | null = null;
  let settleTimer: unknown = null;
  let coalesceTimer: unknown = null;
  let disposed = false;

  const report = (observation: PageObservation) => {
    if (sameReport(reported, observation)) return;
    reported = observation;
    emit(observation);
  };

  const cancelSettle = () => {
    if (settleTimer !== null) timers.clearTimeout(settleTimer);
    settleTimer = null;
  };

  const evaluate = () => {
    if (disposed) return;
    const observation = read();

    if (observation.status === 'generating' || observation.status === 'usage_limit') {
      cancelSettle();
      report(observation);
      return;
    }
    const leavingGeneration = reported?.status === 'generating' && reported.url === observation.url;
    if (!leavingGeneration) {
      cancelSettle();
      report(observation);
      return;
    }
    if (settleTimer === null) {
      settleTimer = timers.setTimeout(() => {
        settleTimer = null;
        if (disposed) return;
        // Report a fresh read, not the one that started the window.
        report(read());
      }, settleMs);
    }
  };

  return {
    schedule() {
      if (disposed || coalesceTimer !== null) return;
      coalesceTimer = timers.setTimeout(() => {
        coalesceTimer = null;
        evaluate();
      }, coalesceMs);
    },
    evaluate,
    current() {
      return read();
    },
    resetReported() {
      reported = null;
    },
    dispose() {
      disposed = true;
      cancelSettle();
      if (coalesceTimer !== null) timers.clearTimeout(coalesceTimer);
      coalesceTimer = null;
    },
  };
}
