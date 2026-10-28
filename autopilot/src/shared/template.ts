// Continuation prompt rendering.
//
// Syntax:
//   {{name}}                      – replaced with the variable's value
//   {{#name}} ... {{/name}}       – the block is kept only when the variable is non-empty;
//                                   a tag on a line of its own removes that line
// Unknown variable names are reported as errors instead of being silently dropped.

import type { ProjectSettings } from './types.ts';

export const DEFAULT_PROMPT_TEMPLATE = `Read {{autopilotPath}} in the connected GitHub repository {{repositoryName}} (branch {{branch}}) and continue development from the recorded state.

Follow the project's rules, priorities and milestone criteria. Current milestone: {{milestone}}

Choose the highest-priority unfinished task, implement it, run the relevant checks, review your changes, and update {{autopilotPath}} with verified progress, failures, decisions and the next action. Do not repeat completed work or claim unverified success. If blocked, document the reason and identify the next safe action.
{{#projectRules}}

Additional standing rules from me:
{{projectRules}}
{{/projectRules}}

End your reply with one line that starts with "AUTOPILOT STATUS:" followed by CONTINUE, MILESTONE COMPLETE or BLOCKED, so I can decide the next step. This is continuation {{cycle}} of at most {{maxCycles}} in this session.`;

export const TEMPLATE_VARIABLES = [
  'projectName',
  'repositoryUrl',
  'repositoryName',
  'branch',
  'milestone',
  'autopilotPath',
  'projectRules',
  'cycle',
  'maxCycles',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Record<TemplateVariable, string>;

export const VARIABLE_DESCRIPTIONS: Record<TemplateVariable, string> = {
  projectName: 'Project name',
  repositoryUrl: 'GitHub repository URL',
  repositoryName: 'owner/repo parsed from the repository URL',
  branch: 'Default branch',
  milestone: 'Milestone description',
  autopilotPath: 'Path to AUTOPILOT.md',
  projectRules: 'Standing rules kept in the extension (may be empty)',
  cycle: 'Number of the continuation being prepared',
  maxCycles: 'Maximum continuations per session',
};

export interface RenderResult {
  text: string;
  errors: string[];
  warnings: string[];
}

const SECTION_RE = /\{\{#\s*([A-Za-z_][\w]*)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g;
// A section tag alone on its line takes the whole line with it, so sections leave no blank lines.
const STANDALONE_TAG_RE = /^[ \t]*(\{\{\s*[#/]\s*[A-Za-z_][\w]*\s*\}\})[ \t]*\r?\n/gm;
const VARIABLE_RE = /\{\{\s*([^{}#/\s][^{}]*?)\s*\}\}/g;
const ANY_TAG_RE = /\{\{\s*[#/]\s*([A-Za-z_][\w]*)\s*\}\}/g;

function isKnown(name: string): name is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

export function parseRepositoryName(url: string): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : '';
}

export function templateValues(project: ProjectSettings, cycle: number): TemplateValues {
  return {
    projectName: project.projectName.trim(),
    repositoryUrl: project.repositoryUrl.trim(),
    repositoryName: parseRepositoryName(project.repositoryUrl) || project.repositoryUrl.trim(),
    branch: project.defaultBranch.trim(),
    milestone: project.milestone.trim(),
    autopilotPath: project.autopilotPath.trim(),
    projectRules: project.projectRules.trim(),
    cycle: String(cycle),
    maxCycles: String(project.maxCyclesPerSession),
  };
}

/** Lists problems in a template without needing values (used by settings validation). */
export function inspectTemplate(template: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!template.trim()) errors.push('The prompt template is empty.');

  const opened: string[] = [];
  for (const match of template.matchAll(ANY_TAG_RE)) {
    const [tag, name = ''] = match;
    if (!isKnown(name)) errors.push(`Unknown section "${name}".`);
    if (tag.includes('#')) opened.push(name);
    else if (opened.pop() !== name) errors.push(`Section "${name}" is closed without a matching opening tag.`);
  }
  for (const name of opened) errors.push(`Section "${name}" is not closed with {{/${name}}}.`);

  for (const match of template.replace(ANY_TAG_RE, '').matchAll(VARIABLE_RE)) {
    const name = match[1] ?? '';
    if (!isKnown(name)) errors.push(`Unknown variable "{{${name}}}". Known variables: ${TEMPLATE_VARIABLES.join(', ')}.`);
  }
  if (!/autopilotPath|AUTOPILOT/i.test(template)) {
    warnings.push('The template does not mention {{autopilotPath}} or AUTOPILOT.md, so ChatGPT may not read the project state.');
  }
  return { errors: [...new Set(errors)], warnings };
}

export function renderTemplate(template: string, values: TemplateValues): RenderResult {
  const { errors, warnings } = inspectTemplate(template);
  if (errors.length) return { text: '', errors, warnings };

  const withSections = template.replace(STANDALONE_TAG_RE, '$1').replace(SECTION_RE, (_whole, name: string, body: string) =>
    isKnown(name) && values[name].trim() ? body : '',
  );
  const missing = new Set<string>();
  const text = withSections.replace(VARIABLE_RE, (_whole, name: string) => {
    const value = isKnown(name) ? values[name] : '';
    if (!value.trim()) missing.add(name);
    return value;
  });
  for (const name of missing) warnings.push(`Variable "{{${name}}}" has no value; it was rendered as empty text.`);
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), errors: [], warnings };
}
