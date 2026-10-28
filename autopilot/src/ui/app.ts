// Shared script for the side panel and the popup. The page decides which
// sections exist; this script fills in whatever it finds.

import autopilotTemplate from '../../templates/AUTOPILOT.md';
import type { UiRequest, UiResponse, UiSnapshot } from '../shared/messages.ts';
import { activeProject } from '../shared/settings.ts';
import { DEFAULT_PROMPT_TEMPLATE, TEMPLATE_VARIABLES, VARIABLE_DESCRIPTIONS } from '../shared/template.ts';
import type { ProjectSettings, ReviewOutcome } from '../shared/types.ts';
import { buildDashboard, formatTime, type DashboardModel } from './viewModel.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

let snapshot: UiSnapshot | null = null;
let formDirty = false;

// ---- Messaging --------------------------------------------------------------

async function request(message: UiRequest): Promise<UiResponse> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as UiResponse | undefined;
    return response ?? { ok: false, error: 'The extension did not answer. Try reopening this panel.' };
  } catch (error) {
    return { ok: false, error: `The extension could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function act(message: UiRequest, busyButton?: HTMLButtonElement | null): Promise<UiResponse> {
  if (busyButton) busyButton.disabled = true;
  const response = await request(message);
  if (response.snapshot) render(response.snapshot);
  if (response.ok) showBanner(response.note ?? '', 'info');
  else showBanner(response.error, 'danger');
  if (busyButton) {
    // Re-enable, then let render() apply the real enabled state for action buttons.
    busyButton.disabled = false;
    if (snapshot) render(snapshot);
  }
  return response;
}

// ---- Banner and dialogs -------------------------------------------------------

function showBanner(text: string, tone: 'info' | 'danger' | 'success'): void {
  const banner = $('banner');
  if (!banner) return;
  banner.textContent = text;
  banner.dataset.tone = tone;
  banner.hidden = !text;
}

function confirmDialog(message: string, confirmLabel = 'Continue'): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('confirm-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(message));
  $('confirm-message')!.textContent = message;
  $('confirm-ok')!.textContent = confirmLabel;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.returnValue = '';
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

function reviewDialog(): Promise<ReviewOutcome | null> {
  const dialog = $<HTMLDialogElement>('review-dialog');
  if (!dialog) return Promise.resolve(null);
  const form = dialog.querySelector('form')!;
  form.reset();
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue !== 'ok') return resolve(null);
      const choice = new FormData(form).get('outcome');
      resolve(choice === 'continue' || choice === 'milestone_reported' || choice === 'blocker_reported' ? choice : null);
    };
    dialog.returnValue = '';
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

// ---- Clipboard ----------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// ---- Rendering ----------------------------------------------------------------

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

function setTone(id: string, tone: string): void {
  const el = $(id);
  if (el) el.dataset.tone = tone;
}

function setEnabled(id: string, enabled: boolean): void {
  const el = $<HTMLButtonElement>(id);
  if (el) el.disabled = !enabled;
}

function renderList(id: string, items: string[]): void {
  const el = $(id);
  if (!el) return;
  el.replaceChildren(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
  el.hidden = items.length === 0;
}

function renderDashboard(model: DashboardModel, snap: UiSnapshot): void {
  setText('project-name', model.projectName);
  setText('milestone', model.milestone);
  setText('obs-status', model.observed.status);
  setTone('obs-status', model.observed.tone);
  setText('obs-updated', model.observed.updated);
  setText('obs-scope', model.observed.scope);
  setText('wf-monitoring', model.workflow.monitoring);
  setTone('wf-monitoring', model.workflow.monitoringTone);
  setText('wf-cycle', model.workflow.cycle);
  setText('wf-phase', model.workflow.phase);
  setText('wf-last-continuation', model.workflow.lastContinuation);
  setText('wf-stop-reason', model.workflow.stopReason);
  setText('rep-outcome', model.reported.outcome);
  setText('next-step', model.nextStep);
  setText('prompt-cycle', model.prompt.cycleLabel);
  const preview = $<HTMLTextAreaElement>('prompt-preview');
  if (preview) preview.value = model.prompt.text || (model.prompt.errors.length ? '' : 'No prompt yet — create and configure a project.');
  renderList('prompt-errors', model.prompt.errors);
  renderList('prompt-warnings', model.prompt.warnings);
  renderList('config-problems', model.configValid ? [] : model.configProblems);

  const recovered = $('recovered-notice');
  if (recovered) {
    recovered.textContent = model.recoveredNotice ?? '';
    recovered.hidden = !model.recoveredNotice;
  }

  setEnabled('btn-start', model.actions.start);
  setEnabled('btn-copy', model.actions.copy);
  setEnabled('btn-insert', model.actions.insert);
  setEnabled('btn-review', model.actions.review);
  setEnabled('btn-pause', model.actions.pause);
  setEnabled('btn-resume', model.actions.resume);
  setEnabled('btn-stop', model.actions.stop);
  setEnabled('btn-reset', model.actions.reset);
  const insert = $('btn-insert');
  if (insert) insert.title = snap.chatgptTabAvailable ? 'Place the prompt in the ChatGPT message box. You still press Send.' : 'Open a ChatGPT tab first.';

  const log = $('event-log');
  if (log) {
    const now = Date.now();
    log.replaceChildren(
      ...[...snap.workflow.log].reverse().map((entry) => {
        const li = document.createElement('li');
        const tag = Object.assign(document.createElement('span'), { className: `tag tag-${entry.source}`, textContent: entry.source });
        const time = Object.assign(document.createElement('time'), { textContent: formatTime(entry.at, now) });
        li.append(tag, ' ', entry.message, ' ', time);
        return li;
      }),
    );
  }
}

function renderProjectSelect(snap: UiSnapshot): void {
  const select = $<HTMLSelectElement>('project-select');
  if (!select) return;
  select.replaceChildren(
    ...snap.settings.projects.map((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.projectName.trim() || 'Untitled project';
      option.selected = p.id === snap.settings.activeProjectId;
      return option;
    }),
  );
  select.disabled = snap.settings.projects.length === 0;
}

const FORM_FIELDS = ['projectName', 'repositoryUrl', 'defaultBranch', 'milestone', 'autopilotPath', 'promptTemplate', 'projectRules', 'maxCyclesPerSession', 'showNotifications', 'requireConfirmation'] as const;

function formElement(name: string): HTMLInputElement | HTMLTextAreaElement | null {
  const form = $<HTMLFormElement>('project-form');
  return (form?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null) ?? null;
}

function fillForm(project: ProjectSettings | null): void {
  const form = $<HTMLFormElement>('project-form');
  if (!form) return;
  const fieldset = $<HTMLFieldSetElement>('project-fields');
  if (fieldset) fieldset.disabled = !project;
  for (const name of FORM_FIELDS) {
    const el = formElement(name);
    if (!el) continue;
    const value = project?.[name];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value === true;
    else el.value = value === undefined ? '' : String(value);
  }
  formDirty = false;
  setText('form-state', '');
}

function readForm(base: ProjectSettings): ProjectSettings {
  const next: ProjectSettings = { ...base };
  const text = (name: string) => formElement(name)?.value ?? '';
  const checked = (name: string) => (formElement(name) as HTMLInputElement | null)?.checked ?? false;
  next.projectName = text('projectName');
  next.repositoryUrl = text('repositoryUrl').trim();
  next.defaultBranch = text('defaultBranch').trim();
  next.milestone = text('milestone');
  next.autopilotPath = text('autopilotPath').trim();
  next.promptTemplate = text('promptTemplate');
  next.projectRules = text('projectRules');
  next.maxCyclesPerSession = Number(text('maxCyclesPerSession'));
  next.showNotifications = checked('showNotifications');
  next.requireConfirmation = checked('requireConfirmation');
  return next;
}

function renderFieldErrors(snap: UiSnapshot): void {
  for (const name of FORM_FIELDS) {
    const holder = $(`err-${name}`);
    const el = formElement(name);
    const issues = snap.validation?.errors.filter((e) => e.field === name).map((e) => e.message) ?? [];
    const warnings = snap.validation?.warnings.filter((e) => e.field === name).map((e) => e.message) ?? [];
    if (holder) {
      holder.textContent = [...issues, ...warnings].join(' ');
      holder.dataset.tone = issues.length ? 'danger' : 'warning';
    }
    if (el) el.setAttribute('aria-invalid', issues.length ? 'true' : 'false');
  }
}

function render(next: UiSnapshot): void {
  const previousProjectId = snapshot?.settings.activeProjectId;
  snapshot = next;
  const project = activeProject(next.settings);
  renderDashboard(buildDashboard(next, Date.now()), next);
  renderProjectSelect(next);
  // Never overwrite what the user is typing, unless they switched projects.
  if (!formDirty || previousProjectId !== next.settings.activeProjectId) {
    fillForm(project);
    renderFieldErrors(next);
  }
  const noProject = $('no-project');
  if (noProject) noProject.hidden = !!project;
}

// ---- Actions ------------------------------------------------------------------

async function handOff(method: 'copy' | 'insert'): Promise<void> {
  if (!snapshot) return;
  const model = buildDashboard(snapshot, Date.now());
  if (model.handoffStartsCycle && model.requireConfirmation) {
    const verb = method === 'insert' ? 'insert continuation prompt' : 'copy continuation prompt';
    const ok = await confirmDialog(
      `This will ${verb} ${snapshot.prompt?.cycle ?? ''} and count it as cycle ${snapshot.workflow.cycle + 1}. ` +
        'The extension never sends messages: review the prompt in ChatGPT and press Send yourself.',
      method === 'insert' ? 'Insert prompt' : 'Copy prompt',
    );
    if (!ok) return;
  }

  if (method === 'copy') {
    const text = snapshot.prompt?.text ?? '';
    if (!text || !(await copyText(text))) {
      showBanner('Copying failed. Select the prompt preview and copy it manually.', 'danger');
      return;
    }
    if (!model.handoffStartsCycle) {
      const wf = snapshot.workflow;
      showBanner(
        wf.monitoring === 'active' && wf.phase === 'awaiting_response'
          ? `Prompt copied again for cycle ${wf.cycle}; no new cycle was started.`
          : 'Prompt copied. It was not counted as a cycle because no session is waiting for a hand-off.',
        'info',
      );
      return;
    }
    const response = await act({ type: 'RECORD_HANDOFF', method: 'copy' }, $<HTMLButtonElement>('btn-copy'));
    if (response.ok) showBanner(response.note ?? 'Prompt copied. Paste it into ChatGPT, review it and press Send yourself.', 'success');
    return;
  }

  let response = await act({ type: 'INSERT_PROMPT' }, $<HTMLButtonElement>('btn-insert'));
  if (!response.ok && response.code === 'composer_not_empty') {
    const replace = await confirmDialog('The ChatGPT message box already contains text. Replace it with the continuation prompt?', 'Replace text');
    if (replace) response = await act({ type: 'INSERT_PROMPT', overwrite: true }, $<HTMLButtonElement>('btn-insert'));
  }
  if (response.ok) showBanner(response.note ?? 'Prompt inserted. Press Send in ChatGPT yourself.', 'success');
}

function bind(id: string, handler: (button: HTMLButtonElement) => void | Promise<void>): void {
  const el = $<HTMLButtonElement>(id);
  el?.addEventListener('click', () => void handler(el));
}

function selectTab(name: string, focusId?: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    if (panel) panel.hidden = !selected;
  }
  if (focusId) $(focusId)?.focus();
}

function setupTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab ?? 'dashboard'));
    tab.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (next) {
        selectTab(next.dataset.tab ?? 'dashboard');
        next.focus();
      }
    });
  });
}

function setupForm(): void {
  const form = $<HTMLFormElement>('project-form');
  if (!form) return;
  const markDirty = (event?: Event) => {
    formDirty = true;
    setText('form-state', 'Unsaved changes');
    // The shown errors describe the saved project; clear them for the field being edited.
    const name = (event?.target as HTMLInputElement | null)?.name;
    if (name) {
      setText(`err-${name}`, '');
      formElement(name)?.setAttribute('aria-invalid', 'false');
    }
  };
  form.addEventListener('input', markDirty);
  for (const el of document.querySelectorAll('[form="project-form"]')) el.addEventListener('input', markDirty);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const project = snapshot ? activeProject(snapshot.settings) : null;
    if (!project) return;
    void (async () => {
      formDirty = false;
      const response = await act({ type: 'SAVE_PROJECT', project: readForm(project) }, $<HTMLButtonElement>('btn-save'));
      if (!response.ok) formDirty = true;
      else if (response.snapshot) fillForm(activeProject(response.snapshot.settings));
    })();
  });

  bind('btn-default-template', async () => {
    if (await confirmDialog('Replace the prompt template with the default? Your current template text will be lost when you save.', 'Use default')) {
      const el = formElement('promptTemplate');
      if (el) el.value = DEFAULT_PROMPT_TEMPLATE;
      markDirty();
    }
  });

  const vars = $('template-variables');
  if (vars) {
    vars.replaceChildren(
      ...TEMPLATE_VARIABLES.map((name) => {
        const li = document.createElement('li');
        li.append(Object.assign(document.createElement('code'), { textContent: `{{${name}}}` }), ` — ${VARIABLE_DESCRIPTIONS[name]}`);
        return li;
      }),
    );
  }
}

function setup(): void {
  setupTabs();
  setupForm();

  bind('btn-start', (b) => void act({ type: 'START_SESSION' }, b));
  bind('btn-copy', () => handOff('copy'));
  bind('btn-insert', () => handOff('insert'));
  bind('btn-review', async (b) => {
    const outcome = await reviewDialog();
    if (outcome) await act({ type: 'MARK_REVIEWED', outcome }, b);
  });
  bind('btn-pause', (b) => void act({ type: 'PAUSE' }, b));
  bind('btn-resume', (b) => void act({ type: 'RESUME' }, b));
  bind('btn-stop', async (b) => {
    if (await confirmDialog('Stop this session? The cycle count resets when you start a new one.', 'Stop session')) await act({ type: 'STOP' }, b);
  });
  bind('btn-reset', (b) => void act({ type: 'RESET' }, b));
  bind('btn-refresh', (b) => void act({ type: 'REFRESH_STATUS' }, b));
  bind('btn-edit-rules', () => selectTab('prompt', 'field-projectRules'));
  bind('btn-help', () => selectTab('help'));
  bind('btn-new-project', async (b) => {
    const open = snapshot && (snapshot.workflow.monitoring === 'active' || snapshot.workflow.monitoring === 'paused');
    if (open && !(await confirmDialog('Creating a project switches to it and stops the running session. Continue?', 'Create project'))) return;
    const response = await act({ type: 'CREATE_PROJECT' }, b);
    if (response.ok) selectTab('project', 'field-projectName');
  });
  bind('btn-delete-project', async (b) => {
    const project = snapshot ? activeProject(snapshot.settings) : null;
    if (!project) return;
    if (await confirmDialog(`Delete the project "${project.projectName || 'Untitled project'}" from the extension? This does not touch the repository.`, 'Delete project')) {
      await act({ type: 'DELETE_PROJECT', projectId: project.id }, b);
    }
  });
  bind('btn-copy-template', async () => {
    showBanner((await copyText(autopilotTemplate)) ? 'AUTOPILOT.md template copied.' : 'Copying failed.', 'info');
  });
  bind('btn-open-panel', async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch (error) {
      showBanner(`The side panel could not be opened: ${error instanceof Error ? error.message : String(error)}`, 'danger');
    }
  });

  const templatePreview = $('template-preview');
  if (templatePreview) templatePreview.textContent = autopilotTemplate;

  $<HTMLSelectElement>('project-select')?.addEventListener('change', async (event) => {
    const select = event.target as HTMLSelectElement;
    const open = snapshot && (snapshot.workflow.monitoring === 'active' || snapshot.workflow.monitoring === 'paused');
    if ((open || formDirty) && !(await confirmDialog('Switching projects stops the running session and discards unsaved changes. Continue?', 'Switch project'))) {
      if (snapshot?.settings.activeProjectId) select.value = snapshot.settings.activeProjectId;
      return;
    }
    formDirty = false;
    await act({ type: 'SELECT_PROJECT', projectId: select.value });
  });

  // Live updates: the background writes state to storage; re-read on change.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') void request({ type: 'GET_SNAPSHOT' }).then((r) => r.snapshot && render(r.snapshot));
  });
  // Relative times ("2 min ago") need a periodic repaint.
  window.setInterval(() => snapshot && renderDashboard(buildDashboard(snapshot, Date.now()), snapshot), 30_000);

  void act({ type: 'REFRESH_STATUS' });
}

document.addEventListener('DOMContentLoaded', setup);
