// Test doubles: a fake page for the DOM reader, a fake storage area and fake timers.

import type { ElementLike, QueryRoot } from '../../src/content/page.ts';
import { DEFAULT_SELECTORS } from '../../src/content/selectors.ts';
import { defaultProject } from '../../src/shared/settings.ts';
import type { StorageAreaLike } from '../../src/shared/storage.ts';
import type { PageObservation, PageSignals, ProjectSettings } from '../../src/shared/types.ts';

export interface FakeElementSpec {
  text?: string;
  attrs?: Record<string, string>;
  visible?: boolean;
  /** Pretend the element sits inside a conversation message. */
  insideMessage?: boolean;
}

export function fakeElement(spec: FakeElementSpec = {}): ElementLike {
  return {
    textContent: spec.text ?? '',
    getAttribute: (name) => spec.attrs?.[name] ?? null,
    closest: (selector) => (selector === DEFAULT_SELECTORS.messageContainer && spec.insideMessage ? {} : null),
    checkVisibility: () => spec.visible !== false,
  };
}

export function fakeRoot(bySelector: Record<string, FakeElementSpec[]>): QueryRoot {
  return {
    querySelectorAll(selector: string) {
      if (selector.includes('!!invalid')) throw new SyntaxError('invalid selector');
      return (bySelector[selector] ?? []).map(fakeElement);
    },
  };
}

export interface PageSpec {
  composer?: boolean;
  stop?: boolean;
  send?: boolean;
  streaming?: boolean;
  assistantIds?: (string | null)[];
  notices?: FakeElementSpec[];
}

/** Builds a fake ChatGPT page from a short description, using the first selector of each kind. */
export function fakePage(spec: PageSpec): QueryRoot {
  const s = DEFAULT_SELECTORS;
  const map: Record<string, FakeElementSpec[]> = {};
  if (spec.composer !== false) map[s.composer[0]!] = [{}];
  if (spec.stop) map[s.stopControl[0]!] = [{}];
  if (spec.send) map[s.sendControl[0]!] = [{}];
  if (spec.streaming) map[s.streamingMarker[0]!] = [{}];
  if (spec.assistantIds) {
    map[s.assistantMessage[0]!] = spec.assistantIds.map((id) => ({ attrs: id ? { [s.messageIdAttribute]: id } : {} }));
  }
  if (spec.notices) map[s.noticeRegion[0]!] = spec.notices;
  return fakeRoot(map);
}

export function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    composerFound: true,
    stopControlFound: false,
    sendControlFound: true,
    streamingMarkerFound: false,
    assistantMessageCount: 0,
    errorNoticeFound: false,
    usageLimitNoticeFound: false,
    ...overrides,
  };
}

export const CONVO = 'https://chatgpt.com/c/abc';

export function obs(status: PageObservation['status'], key: string | null = null, url = CONVO): PageObservation {
  return { status, responseKey: key, url, signals: signals() };
}

export function validProject(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    ...defaultProject('p1'),
    projectName: 'Demo',
    repositoryUrl: 'https://github.com/octo/demo',
    defaultBranch: 'main',
    milestone: 'MVP: login and dashboard',
    maxCyclesPerSession: 3,
    ...overrides,
  };
}

export class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  writes = 0;
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) if (key in this.data) out[key] = structuredClone(this.data[key]);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    this.writes += 1;
    for (const [key, value] of Object.entries(items)) this.data[key] = structuredClone(value);
  }
}

export class FakeTimers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; cb: () => void }>();
  setTimeout = (cb: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, cb });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].cb();
    }
    this.now = target;
  }
  get size(): number {
    return this.pending.size;
  }
}
