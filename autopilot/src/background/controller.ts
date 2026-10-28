// Background logic, independent of the chrome.* APIs so it can be tested.
// It is the only writer of settings and workflow state. All operations run
// one at a time and always start from persisted state, because Chrome may
// stop the service worker between events.

import type { ContentReport, InsertResult, UiRequest, UiResponse, UiSnapshot } from '../shared/messages.ts';
import type { Logger } from '../shared/logger.ts';
import { activeProject, defaultProject, looksLikeSecret, normalizeProject, validateProject } from '../shared/settings.ts';
import { createSerialQueue, loadSettings, loadWorkflow, saveSettings, saveWorkflow, type StorageAreaLike } from '../shared/storage.ts';
import { renderTemplate, templateValues } from '../shared/template.ts';
import type { PageObservation, ProjectSettings, SettingsStore, WorkflowState } from '../shared/types.ts';
import { transition, type NotifyEffect, type TransitionResult, type WorkflowEvent } from '../shared/workflow.ts';

export interface TabAccess {
  /** The tab a prompt should go to: the tracked tab if it still shows ChatGPT, else the active ChatGPT tab. */
  findTargetTab(preferredTabId: number | null): Promise<number | null>;
  anyChatgptTab(): Promise<boolean>;
  /** Asks the content script in a tab for a fresh observation; null if it does not answer. */
  getObservation(tabId: number): Promise<PageObservation | null>;
  insert(tabId: number, text: string, overwrite: boolean): Promise<InsertResult>;
}

export interface ControllerDeps {
  storage: StorageAreaLike;
  tabs: TabAccess;
  notify(effect: NotifyEffect): Promise<void>;
  onStateChange?(state: WorkflowState): Promise<void> | void;
  now(): number;
  log: Logger;
}

export interface Controller {
  handleUi(request: UiRequest): Promise<UiResponse>;
  handleContent(tabId: number, report: ContentReport): Promise<void>;
  handleTabRemoved(tabId: number): Promise<void>;
  handleStartup(): Promise<void>;
}

class UserError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function nextPromptCycle(state: WorkflowState): number {
  if (state.monitoring === 'active' || state.monitoring === 'paused') {
    return state.phase === 'awaiting_response' ? state.cycle : state.cycle + 1;
  }
  return 1;
}

export function renderPromptFor(project: ProjectSettings, state: WorkflowState): NonNullable<UiSnapshot['prompt']> {
  const cycle = nextPromptCycle(state);
  return { ...renderTemplate(project.promptTemplate, templateValues(project, cycle)), cycle };
}

export function createController(deps: ControllerDeps): Controller {
  const { storage, tabs, log } = deps;
  const enqueue = createSerialQueue();

  async function load(): Promise<{ settings: SettingsStore; settingsRecovered: boolean; workflow: WorkflowState }> {
    const [{ store, recovered }, workflow] = await Promise.all([loadSettings(storage), loadWorkflow(storage)]);
    return { settings: store, settingsRecovered: recovered, workflow };
  }

  async function apply(workflow: WorkflowState, event: WorkflowEvent, settings: SettingsStore): Promise<TransitionResult> {
    const result = transition(workflow, event);
    if (result.state !== workflow) {
      await saveWorkflow(storage, result.state);
      await deps.onStateChange?.(result.state);
    }
    const project = activeProject(settings);
    const allowNotifications = project?.showNotifications ?? true;
    for (const effect of result.effects) {
      if (!allowNotifications) continue;
      try {
        await deps.notify(effect);
      } catch (error) {
        log.warn('Notification failed', error);
      }
    }
    return result;
  }

  /** Keeps the workflow bound to the active project. */
  async function reconcile(settings: SettingsStore, workflow: WorkflowState): Promise<WorkflowState> {
    if (workflow.projectId === settings.activeProjectId) return workflow;
    return (await apply(workflow, { type: 'SELECT_PROJECT', projectId: settings.activeProjectId, now: deps.now() }, settings)).state;
  }

  async function snapshot(settings: SettingsStore, settingsRecovered: boolean, workflow: WorkflowState): Promise<UiSnapshot> {
    const project = activeProject(settings);
    let chatgptTabAvailable = false;
    try {
      chatgptTabAvailable = await tabs.anyChatgptTab();
    } catch (error) {
      log.warn('Could not query tabs', error);
    }
    return {
      settings,
      settingsRecovered,
      workflow,
      validation: project ? validateProject(project) : null,
      prompt: project ? renderPromptFor(project, workflow) : null,
      chatgptTabAvailable,
    };
  }

  function requireValidProject(settings: SettingsStore): ProjectSettings {
    const project = activeProject(settings);
    if (!project) throw new UserError('Create a project first.', 'no_project');
    const validation = validateProject(project);
    if (!validation.valid) {
      throw new UserError(`The project settings need attention: ${validation.errors.map((e) => e.message).join(' ')}`, 'invalid_project');
    }
    return project;
  }

  function requirePrompt(project: ProjectSettings, workflow: WorkflowState): string {
    const prompt = renderPromptFor(project, workflow);
    if (prompt.errors.length || !prompt.text) throw new UserError(`The prompt template cannot be rendered: ${prompt.errors.join(' ')}`, 'template_error');
    return prompt.text;
  }

  async function safeObservation(tabId: number): Promise<PageObservation | null> {
    try {
      return await tabs.getObservation(tabId);
    } catch {
      return null;
    }
  }

  async function refreshFromTab(settings: SettingsStore, workflow: WorkflowState): Promise<WorkflowState> {
    const tabId = await tabs.findTargetTab(workflow.trackedTabId);
    if (tabId === null) return workflow;
    const observation = await safeObservation(tabId);
    if (!observation) return workflow;
    return (await apply(workflow, { type: 'OBSERVATION', tabId, observation, now: deps.now() }, settings)).state;
  }

  async function handle(request: UiRequest): Promise<UiResponse> {
    let { settings, settingsRecovered, workflow } = await load();
    workflow = await reconcile(settings, workflow);
    let note: string | undefined;
    const now = deps.now();
    const maxCycles = activeProject(settings)?.maxCyclesPerSession ?? 1;

    const run = async (event: WorkflowEvent) => {
      const result = await apply(workflow, event, settings);
      if (result.rejected && result.state === workflow) throw new UserError(result.rejected);
      workflow = result.state;
      note = result.rejected ?? result.note;
    };

    const saveStore = async (next: SettingsStore) => {
      await saveSettings(storage, next);
      settings = next;
      settingsRecovered = false;
      workflow = await reconcile(settings, workflow);
    };

    switch (request.type) {
      case 'GET_SNAPSHOT':
        break;

      case 'REFRESH_STATUS':
        workflow = await refreshFromTab(settings, workflow);
        break;

      case 'SAVE_PROJECT': {
        const project = normalizeProject(request.project);
        if (!project) throw new UserError('The project data is invalid.');
        const secretField = (['projectName', 'repositoryUrl', 'defaultBranch', 'milestone', 'autopilotPath', 'promptTemplate', 'projectRules'] as const)
          .find((field) => looksLikeSecret(project[field]));
        if (secretField) throw new UserError('A field looks like it contains an access token or session secret. Remove it; the extension never stores credentials.', 'secret_detected');
        const exists = settings.projects.some((p) => p.id === project.id);
        const projects = exists ? settings.projects.map((p) => (p.id === project.id ? project : p)) : [...settings.projects, project];
        await saveStore({ ...settings, projects, activeProjectId: settings.activeProjectId ?? project.id });
        const validation = validateProject(project);
        note = validation.valid ? 'Project saved.' : 'Saved as a draft. Fix the highlighted fields before starting a session.';
        break;
      }

      case 'CREATE_PROJECT': {
        const project = defaultProject();
        await saveStore({ ...settings, projects: [...settings.projects, project], activeProjectId: project.id });
        break;
      }

      case 'DELETE_PROJECT': {
        if (!settings.projects.some((p) => p.id === request.projectId)) throw new UserError('That project no longer exists.');
        const projects = settings.projects.filter((p) => p.id !== request.projectId);
        const activeProjectId = settings.activeProjectId === request.projectId ? projects[0]?.id ?? null : settings.activeProjectId;
        await saveStore({ ...settings, projects, activeProjectId });
        note = 'Project deleted.';
        break;
      }

      case 'SELECT_PROJECT':
        if (!settings.projects.some((p) => p.id === request.projectId)) throw new UserError('That project no longer exists.');
        await saveStore({ ...settings, activeProjectId: request.projectId });
        break;

      case 'START_SESSION': {
        const project = requireValidProject(settings);
        requirePrompt(project, workflow);
        await run({ type: 'START_SESSION', projectId: project.id, now });
        break;
      }

      case 'RECORD_HANDOFF': {
        const project = requireValidProject(settings);
        requirePrompt(project, workflow);
        const tabId = await tabs.findTargetTab(workflow.trackedTabId);
        const observation = tabId === null ? null : await safeObservation(tabId);
        await run({
          type: 'PROMPT_HANDED_OFF',
          method: 'copy',
          tabId: observation ? tabId : null,
          currentResponseKey: observation?.responseKey ?? null,
          maxCycles: project.maxCyclesPerSession,
          now,
        });
        break;
      }

      case 'INSERT_PROMPT': {
        const project = requireValidProject(settings);
        const text = requirePrompt(project, workflow);
        // Dry run: refuse before touching the page if the hand-off would be rejected.
        const dry = transition(workflow, { type: 'PROMPT_HANDED_OFF', method: 'insert', tabId: null, currentResponseKey: null, maxCycles: project.maxCyclesPerSession, now });
        if (dry.rejected) throw new UserError(dry.rejected);
        const tabId = await tabs.findTargetTab(workflow.trackedTabId);
        if (tabId === null) throw new UserError('Open your ChatGPT conversation and make it the active tab, then try again.', 'no_tab');
        const observation = await safeObservation(tabId);
        if (!observation) {
          throw new UserError('The extension is not attached to that ChatGPT tab yet (for example, it was open before the extension was installed). Reload that tab yourself, or use Copy prompt.', 'no_content_script');
        }
        if (observation.status === 'generating') throw new UserError('ChatGPT is still responding in that tab. Wait for it to finish.', 'generating');
        if (observation.status === 'usage_limit') throw new UserError('ChatGPT is showing a usage-limit message. Nothing was inserted.', 'usage_limit');
        let result: InsertResult;
        try {
          result = await tabs.insert(tabId, text, request.overwrite === true);
        } catch (error) {
          log.warn('Insert failed', error);
          throw new UserError('The ChatGPT tab did not respond. Use Copy prompt instead.', 'insert_failed');
        }
        if (!result.ok) throw new UserError(result.error, result.code);
        await run({
          type: 'PROMPT_HANDED_OFF',
          method: 'insert',
          tabId,
          currentResponseKey: observation.responseKey,
          maxCycles: project.maxCyclesPerSession,
          now,
        });
        note = note ?? 'Prompt inserted. Review it in ChatGPT and press Send yourself.';
        break;
      }

      case 'MARK_REVIEWED':
        await run({ type: 'MARK_REVIEWED', outcome: request.outcome, maxCycles, now });
        break;

      case 'PAUSE':
        await run({ type: 'PAUSE', now });
        break;

      case 'RESUME':
        await run({ type: 'RESUME', now });
        // Pick up anything that finished while paused.
        workflow = await refreshFromTab(settings, workflow);
        break;

      case 'STOP':
        await run({ type: 'STOP', reason: 'user_stopped', now });
        break;

      case 'RESET':
        await run({ type: 'RESET', now });
        break;
    }

    return { ok: true, snapshot: await snapshot(settings, settingsRecovered, workflow), ...(note ? { note } : {}) };
  }

  return {
    handleUi(request) {
      return enqueue(async () => {
        try {
          return await handle(request);
        } catch (error) {
          const { settings, settingsRecovered, workflow } = await load().catch(() => ({ settings: null, settingsRecovered: false, workflow: null }));
          const snap = settings && workflow ? await snapshot(settings, settingsRecovered, workflow) : undefined;
          if (error instanceof UserError) {
            return { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}), ...(snap ? { snapshot: snap } : {}) };
          }
          log.error(`Request ${request.type} failed`, error);
          return { ok: false, error: 'Something went wrong in the extension. Details are in the service worker console.', ...(snap ? { snapshot: snap } : {}) };
        }
      });
    },

    handleContent(tabId, report) {
      return enqueue(async () => {
        try {
          const { settings, workflow } = await load();
          const current = await reconcile(settings, workflow);
          await apply(current, { type: 'OBSERVATION', tabId, observation: report.observation, now: deps.now() }, settings);
        } catch (error) {
          log.error('Could not process page observation', error);
        }
      });
    },

    handleTabRemoved(tabId) {
      return enqueue(async () => {
        try {
          const { settings, workflow } = await load();
          await apply(workflow, { type: 'TAB_CLOSED', tabId, now: deps.now() }, settings);
        } catch (error) {
          log.error('Could not process closed tab', error);
        }
      });
    },

    handleStartup() {
      return enqueue(async () => {
        try {
          const { settings, workflow } = await load();
          await apply(workflow, { type: 'BROWSER_STARTUP', now: deps.now() }, settings);
        } catch (error) {
          log.error('Could not restore state on startup', error);
        }
      });
    },
  };
}
