// Shared data shapes. Everything here is plain JSON so it can be persisted in
// chrome.storage and passed through extension messaging unchanged.

export interface ProjectSettings {
  id: string;
  projectName: string;
  repositoryUrl: string;
  defaultBranch: string;
  milestone: string;
  autopilotPath: string;
  promptTemplate: string;
  /** Extra standing rules the user keeps in the extension (rendered via {{projectRules}}). */
  projectRules: string;
  maxCyclesPerSession: number;
  showNotifications: boolean;
  /** Ask for an extra confirmation before a prompt is handed off (copied or inserted). */
  requireConfirmation: boolean;
}

export interface SettingsStore {
  schemaVersion: 1;
  activeProjectId: string | null;
  projects: ProjectSettings[];
}

/**
 * What the content script observed on the ChatGPT page. "unknown" means the
 * page did not expose enough information; it is never upgraded to a guess.
 */
export type ResponseStatus =
  | 'unknown'
  | 'idle'
  | 'generating'
  | 'complete'
  | 'error'
  | 'usage_limit';

export type MonitoringState = 'inactive' | 'active' | 'paused' | 'stopped';

/**
 * ready              – a continuation prompt is prepared and waits for the user to hand it off
 * awaiting_response  – the user copied/inserted the prompt; waiting for ChatGPT's response
 * needs_review       – a response appears complete; the user should review it
 */
export type CyclePhase = 'ready' | 'awaiting_response' | 'needs_review';

export type StopReason =
  | 'user_stopped'
  | 'max_cycles_reached'
  | 'milestone_reported'
  | 'blocker_reported'
  | 'project_changed';

export type PauseReason = 'user' | 'usage_limit';

/** What the user recorded after reading ChatGPT's reply. This is reported, not observed. */
export type ReviewOutcome = 'continue' | 'milestone_reported' | 'blocker_reported';

export interface WorkflowState {
  schemaVersion: 1;
  projectId: string | null;
  monitoring: MonitoringState;
  pauseReason: PauseReason | null;
  phase: CyclePhase;
  /** Number of continuation prompts handed off in this session. */
  cycle: number;
  /** Observed by the content script. */
  responseStatus: ResponseStatus;
  /** Opaque identifier of the latest assistant response seen (conversation path + message id or count). */
  lastResponseKey: string | null;
  /** Response key that was current when the prompt was handed off; a completion must differ from it. */
  responseKeyAtHandoff: string | null;
  /** Whether the tracked tab was observed generating since the last hand-off. */
  generationSeenSinceHandoff: boolean;
  /** Keys for which a completion notification was already shown. Bounded. */
  notifiedResponseKeys: string[];
  /** Whether the latest observed response has been reviewed by the user. */
  latestReviewed: boolean;
  promptPrepared: boolean;
  trackedTabId: number | null;
  conversationUrl: string | null;
  lastEventAt: number | null;
  lastContinuationAt: number | null;
  lastReviewOutcome: ReviewOutcome | null;
  stopReason: StopReason | null;
  /** Set when stored state was unreadable and replaced with defaults. */
  recoveredFromCorruption: boolean;
  /** Bounded list of recent workflow events, newest last. Never contains ChatGPT message text. */
  log: WorkflowLogEntry[];
}

export interface WorkflowLogEntry {
  at: number;
  source: 'observed' | 'user' | 'system';
  message: string;
}

/** Observation sent by a content script. Never contains message text. */
export interface PageObservation {
  status: ResponseStatus;
  responseKey: string | null;
  url: string;
  /** Diagnostic: which signals were present, for the "why unknown" display. */
  signals: PageSignals;
}

export interface PageSignals {
  composerFound: boolean;
  stopControlFound: boolean;
  sendControlFound: boolean;
  streamingMarkerFound: boolean;
  assistantMessageCount: number;
  errorNoticeFound: boolean;
  usageLimitNoticeFound: boolean;
}

export interface ValidationIssue {
  field: keyof ProjectSettings | 'general';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
