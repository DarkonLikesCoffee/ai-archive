// Project settings: defaults, validation and normalization of stored data.

import { DEFAULT_PROMPT_TEMPLATE, inspectTemplate } from './template.ts';
import type { ProjectSettings, SettingsStore, ValidationIssue, ValidationResult } from './types.ts';

export const MAX_CYCLES_LIMIT = 100;
export const MAX_TEMPLATE_LENGTH = 8000;
export const MAX_RULES_LENGTH = 4000;

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultProject(id: string = newProjectId()): ProjectSettings {
  return {
    id,
    projectName: '',
    repositoryUrl: '',
    defaultBranch: 'main',
    milestone: '',
    autopilotPath: 'AUTOPILOT.md',
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    projectRules: '',
    maxCyclesPerSession: 10,
    showNotifications: true,
    requireConfirmation: true,
  };
}

export function defaultSettingsStore(): SettingsStore {
  return { schemaVersion: 1, activeProjectId: null, projects: [] };
}

// Credentials must never be stored. These patterns catch the common ones a
// user might paste by accident (GitHub tokens, OpenAI keys, bearer headers).
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /__Secure-next-auth\.session-token/i,
];

export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value));
}

const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+?(?:\.git)?\/?$/;

export function validateBranchName(branch: string): string | null {
  const b = branch.trim();
  if (!b) return 'The default branch is required.';
  if (b.length > 200) return 'The branch name is too long.';
  if (/[\s~^:?*[\\]/.test(b) || b.includes('..') || b.includes('@{') || b.includes('//')) {
    return 'The branch name contains characters Git does not allow.';
  }
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) {
    return 'The branch name is not a valid Git branch name.';
  }
  return null;
}

export function validateAutopilotPath(path: string): string | null {
  const p = path.trim();
  if (!p) return 'The path to AUTOPILOT.md is required.';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'Use a path relative to the repository root, for example AUTOPILOT.md or docs/AUTOPILOT.md.';
  if (p.split(/[\\/]/).some((segment) => segment === '..' || segment === '')) return 'The path must not contain empty or ".." segments.';
  if (!/\.md$/i.test(p)) return 'The path must point to a Markdown (.md) file.';
  return null;
}

export function validateProject(project: ProjectSettings): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (field: ValidationIssue['field'], message: string) => errors.push({ field, message });

  const name = project.projectName.trim();
  if (!name) err('projectName', 'The project name is required.');
  else if (name.length > 100) err('projectName', 'The project name must be 100 characters or fewer.');

  const url = project.repositoryUrl.trim();
  if (!url) err('repositoryUrl', 'The GitHub repository URL is required.');
  else if (/^https:\/\/[^/]*@/.test(url)) err('repositoryUrl', 'Remove credentials from the URL. The extension never stores GitHub credentials.');
  else if (!REPO_URL_RE.test(url)) err('repositoryUrl', 'Use a GitHub repository URL like https://github.com/owner/repo.');

  const branchError = validateBranchName(project.defaultBranch);
  if (branchError) err('defaultBranch', branchError);

  if (!project.milestone.trim()) err('milestone', 'Describe the current milestone so ChatGPT knows when to stop.');
  else if (project.milestone.length > 2000) err('milestone', 'The milestone description must be 2000 characters or fewer.');

  const pathError = validateAutopilotPath(project.autopilotPath);
  if (pathError) err('autopilotPath', pathError);

  if (project.promptTemplate.length > MAX_TEMPLATE_LENGTH) {
    err('promptTemplate', `The prompt template must be ${MAX_TEMPLATE_LENGTH} characters or fewer.`);
  }
  const inspection = inspectTemplate(project.promptTemplate);
  for (const message of inspection.errors) err('promptTemplate', message);
  for (const message of inspection.warnings) warnings.push({ field: 'promptTemplate', message });

  if (project.projectRules.length > MAX_RULES_LENGTH) err('projectRules', `Project rules must be ${MAX_RULES_LENGTH} characters or fewer.`);

  const max = project.maxCyclesPerSession;
  if (!Number.isInteger(max) || max < 1 || max > MAX_CYCLES_LIMIT) {
    err('maxCyclesPerSession', `Maximum cycles must be a whole number from 1 to ${MAX_CYCLES_LIMIT}.`);
  }

  const textFields: (keyof ProjectSettings)[] = ['projectName', 'repositoryUrl', 'milestone', 'promptTemplate', 'projectRules'];
  for (const field of textFields) {
    const value = project[field];
    if (typeof value === 'string' && looksLikeSecret(value)) {
      err(field, 'This looks like an access token or session secret. Remove it: the extension never stores credentials.');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Coerces unknown stored data into a ProjectSettings, filling gaps with defaults. */
export function normalizeProject(raw: unknown): ProjectSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const d = defaultProject(r.id);
  const max = typeof r.maxCyclesPerSession === 'number' && Number.isFinite(r.maxCyclesPerSession) ? Math.trunc(r.maxCyclesPerSession) : d.maxCyclesPerSession;
  return {
    id: r.id,
    projectName: str(r.projectName, d.projectName),
    repositoryUrl: str(r.repositoryUrl, d.repositoryUrl),
    defaultBranch: str(r.defaultBranch, d.defaultBranch),
    milestone: str(r.milestone, d.milestone),
    autopilotPath: str(r.autopilotPath, d.autopilotPath),
    promptTemplate: str(r.promptTemplate, d.promptTemplate),
    projectRules: str(r.projectRules, d.projectRules),
    maxCyclesPerSession: max,
    showNotifications: bool(r.showNotifications, d.showNotifications),
    requireConfirmation: bool(r.requireConfirmation, d.requireConfirmation),
  };
}

export function normalizeSettingsStore(raw: unknown): { store: SettingsStore; recovered: boolean } {
  if (raw === undefined || raw === null) return { store: defaultSettingsStore(), recovered: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { store: defaultSettingsStore(), recovered: true };
  const r = raw as Record<string, unknown>;
  let recovered = r.schemaVersion !== 1;
  const projects: ProjectSettings[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(r.projects) ? r.projects : []) {
    const project = normalizeProject(item);
    if (!project || seen.has(project.id)) {
      recovered = true;
      continue;
    }
    seen.add(project.id);
    projects.push(project);
  }
  if (!Array.isArray(r.projects)) recovered = true;
  const active = typeof r.activeProjectId === 'string' && seen.has(r.activeProjectId) ? r.activeProjectId : projects[0]?.id ?? null;
  if (typeof r.activeProjectId === 'string' && !seen.has(r.activeProjectId)) recovered = true;
  return { store: { schemaVersion: 1, activeProjectId: active, projects }, recovered };
}

export function activeProject(store: SettingsStore): ProjectSettings | null {
  return store.projects.find((p) => p.id === store.activeProjectId) ?? null;
}
