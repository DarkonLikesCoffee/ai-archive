import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialWorkflowState, isTrackedObservation, MAX_LOG_ENTRIES, MAX_NOTIFIED_KEYS, normalizeWorkflowState, transition,
  type TransitionResult, type WorkflowEvent,
} from '../src/shared/workflow.ts';
import type { WorkflowState } from '../src/shared/types.ts';
import { CONVO, obs } from './helpers/fixtures.ts';

const TAB = 7;
const MAX = 3;

function run(state: WorkflowState, ...events: WorkflowEvent[]): TransitionResult {
  let result: TransitionResult = { state, effects: [] };
  const effects = [];
  for (const event of events) {
    result = transition(result.state, event);
    effects.push(...result.effects);
  }
  return { ...result, effects };
}

const start = (now = 1): WorkflowEvent => ({ type: 'START_SESSION', projectId: 'p1', now });
const handoff = (key: string | null = null, now = 2, tabId: number | null = TAB): WorkflowEvent => ({ type: 'PROMPT_HANDED_OFF', method: 'insert', tabId, currentResponseKey: key, maxCycles: MAX, now });
const see = (o: ReturnType<typeof obs>, now = 3, tabId = TAB): WorkflowEvent => ({ type: 'OBSERVATION', tabId, observation: o, now });
const review = (outcome: 'continue' | 'milestone_reported' | 'blocker_reported' = 'continue', now = 9): WorkflowEvent => ({ type: 'MARK_REVIEWED', outcome, maxCycles: MAX, now });

function started(): WorkflowState {
  return run(initialWorkflowState(), start()).state;
}

test('a session starts with the first prompt prepared', () => {
  const s = started();
  assert.equal(s.monitoring, 'active');
  assert.equal(s.phase, 'ready');
  assert.equal(s.cycle, 0);
  assert.equal(s.promptPrepared, true);
  assert.equal(s.projectId, 'p1');
});

test('a full cycle: hand-off, generating, complete (one notification), review, next prompt', () => {
  const r = run(started(),
    handoff(`/c/abc|id:old`),
    see(obs('generating', '/c/abc|id:new')),
    see(obs('complete', '/c/abc|id:new'), 5),
  );
  assert.equal(r.state.cycle, 1);
  assert.equal(r.state.phase, 'needs_review');
  assert.equal(r.state.latestReviewed, false);
  assert.equal(r.state.trackedTabId, TAB);
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0]!.kind, 'response_complete');

  const after = transition(r.state, review());
  assert.equal(after.state.phase, 'ready');
  assert.equal(after.state.promptPrepared, true);
  assert.equal(after.state.latestReviewed, true);
  assert.equal(after.state.lastReviewOutcome, 'continue');
});

test('the same completion is never notified twice', () => {
  const r = run(started(),
    handoff(),
    see(obs('generating', '/c/abc|id:a')),
    see(obs('complete', '/c/abc|id:a')),
    see(obs('complete', '/c/abc|id:a')),
    see(obs('unknown', '/c/abc|id:a')),
    see(obs('complete', '/c/abc|id:a')),
  );
  assert.equal(r.effects.filter((e) => e.kind === 'response_complete').length, 1);

  // Even after reviewing and handing off again, the old response does not count.
  const next = run(r.state, review(), handoff('/c/abc|id:a', 10), see(obs('complete', '/c/abc|id:a'), 11));
  assert.equal(next.state.phase, 'awaiting_response');
  assert.equal(next.effects.length, 0);
});

test('a response that was already complete before the hand-off is not a completion', () => {
  const r = run(started(), handoff('/c/abc|id:old'), see(obs('complete', '/c/abc|id:old')));
  assert.equal(r.state.phase, 'awaiting_response');
  assert.equal(r.effects.length, 0);
});

test('without a known key at hand-off, completion requires observed generation', () => {
  const r = run(started(), handoff(null), see(obs('complete', '/c/abc|id:x')));
  assert.equal(r.state.phase, 'awaiting_response');
  const r2 = run(r.state, see(obs('generating', '/c/abc|id:y')), see(obs('complete', '/c/abc|id:y')));
  assert.equal(r2.state.phase, 'needs_review');
});

test('a new response key in the same conversation counts even if generation was missed', () => {
  const r = run(started(), handoff('/c/abc|id:old'), see(obs('complete', '/c/abc|id:new')));
  assert.equal(r.state.phase, 'needs_review');
  assert.equal(r.effects.length, 1);
});

test('switching to another conversation is not a completion', () => {
  const r = run(started(), handoff('/c/abc|id:old'), see(obs('complete', '/c/other|id:z', 'https://chatgpt.com/c/other')));
  assert.equal(r.state.phase, 'awaiting_response');
});

test('observations from other tabs are ignored once a tab is tracked', () => {
  const r = run(started(), handoff(null), see(obs('generating', '/c/abc|id:a'), 3, 99));
  assert.equal(r.state.generationSeenSinceHandoff, false);
  assert.equal(r.note, 'Observation from a tab this session does not follow was ignored.');
});

test('a copied prompt without a tab binds to the first tab seen generating', () => {
  const r = run(started(), handoff(null, 2, null), see(obs('generating', '/c/abc|id:a'), 3, 42));
  assert.equal(r.state.trackedTabId, 42);
  assert.equal(r.state.generationSeenSinceHandoff, true);
});

test('hand-off is refused when not active, paused, or awaiting review', () => {
  assert.match(transition(initialWorkflowState(), handoff()).rejected ?? '', /Start a session/);
  const paused = run(started(), { type: 'PAUSE', now: 2 }).state;
  assert.match(transition(paused, handoff()).rejected ?? '', /paused/);
  const reviewing = run(started(), handoff(), see(obs('generating', 'k|1')), see(obs('complete', 'k|1'))).state;
  assert.match(transition(reviewing, handoff()).rejected ?? '', /Mark the previous cycle reviewed/);
});

test('a second hand-off while waiting does not start another cycle', () => {
  const r = run(started(), handoff(), handoff());
  assert.equal(r.state.cycle, 1);
  assert.match(r.note ?? '', /already waiting/);
});

test('the cycle limit stops the session after the last review', () => {
  let s = started();
  const effects = [];
  for (let i = 1; i <= MAX; i += 1) {
    const r = run(s, handoff(null, i * 10), see(obs('generating', `/c/abc|id:${i}`), i * 10 + 1), see(obs('complete', `/c/abc|id:${i}`), i * 10 + 2), review('continue', i * 10 + 3));
    s = r.state;
    effects.push(...r.effects);
  }
  assert.equal(s.cycle, MAX);
  assert.equal(s.monitoring, 'stopped');
  assert.equal(s.stopReason, 'max_cycles_reached');
  assert.equal(effects.filter((e) => e.kind === 'session_ended').length, 1);
  assert.match(transition(s, handoff()).rejected ?? '', /Start a session/);
});

test('reported milestone or blocker stops the session; the extension records it as reported', () => {
  const base = run(started(), handoff(), see(obs('generating', 'k|1')), see(obs('complete', 'k|1'))).state;
  const milestone = transition(base, review('milestone_reported')).state;
  assert.equal(milestone.monitoring, 'stopped');
  assert.equal(milestone.stopReason, 'milestone_reported');
  const blocker = transition(base, review('blocker_reported')).state;
  assert.equal(blocker.stopReason, 'blocker_reported');
});

test('a stopped (interrupted) response only asks for review; it never ends the session', () => {
  const r = run(started(), handoff(), see(obs('generating', 'k|1')), see(obs('complete', 'k|1')));
  assert.equal(r.state.monitoring, 'active');
  assert.equal(r.state.phase, 'needs_review');
  assert.equal(r.state.stopReason, null);
});

test('manual review is allowed when completion was not detected', () => {
  const r = run(started(), handoff('/c/abc|id:old'), see(obs('unknown', null)), review());
  assert.equal(r.state.phase, 'ready');
  assert.equal(r.state.cycle, 1);
  assert.match(r.state.log.at(-2)?.message ?? '', /before completion was detected/);
});

test('pause stops notifications and phase changes; resume continues', () => {
  const paused = run(started(), handoff(), { type: 'PAUSE', now: 3 }, see(obs('generating', 'k|1'), 4), see(obs('complete', 'k|1'), 5));
  assert.equal(paused.state.monitoring, 'paused');
  assert.equal(paused.state.pauseReason, 'user');
  assert.equal(paused.state.phase, 'awaiting_response');
  assert.equal(paused.state.responseStatus, 'complete', 'the observed status is still shown');
  assert.equal(paused.effects.length, 0);

  // On resume the background re-reads the page; the new response key counts.
  const resumed = run(paused.state, { type: 'RESUME', now: 6 }, see(obs('complete', 'k|1'), 7));
  assert.equal(resumed.state.monitoring, 'active');
  assert.equal(resumed.state.phase, 'needs_review');
  assert.equal(resumed.effects.length, 1);
});

test('pause and resume are only valid from the right states', () => {
  assert.ok(transition(initialWorkflowState(), { type: 'PAUSE', now: 1 }).rejected);
  assert.ok(transition(started(), { type: 'RESUME', now: 1 }).rejected);
  assert.ok(transition(initialWorkflowState(), { type: 'STOP', reason: 'user_stopped', now: 1 }).rejected);
});

test('unknown status is recorded as unknown and never advances the cycle', () => {
  const r = run(started(), handoff(), see(obs('unknown', null)), see(obs('unknown', null)));
  assert.equal(r.state.responseStatus, 'unknown');
  assert.equal(r.state.phase, 'awaiting_response');
  assert.equal(r.effects.length, 0);
});

test('a usage-limit message pauses monitoring once and never resends', () => {
  const r = run(started(), handoff(), see(obs('usage_limit', null)), see(obs('usage_limit', null)), see(obs('usage_limit', null)));
  assert.equal(r.state.monitoring, 'paused');
  assert.equal(r.state.pauseReason, 'usage_limit');
  assert.equal(r.state.cycle, 1, 'no new cycle is started');
  assert.deepEqual(r.effects.map((e) => e.kind), ['usage_limit']);
  assert.ok(transition(r.state, handoff()).rejected, 'no hand-off while paused');
});

test('an error notice notifies once per occurrence and changes nothing else', () => {
  const r = run(started(), handoff(), see(obs('error', null)), see(obs('error', null)));
  assert.deepEqual(r.effects.map((e) => e.kind), ['error']);
  assert.equal(r.state.phase, 'awaiting_response');
  assert.equal(r.state.monitoring, 'active');
});

test('stop and reset', () => {
  const stopped = run(started(), handoff(), { type: 'STOP', reason: 'user_stopped', now: 5 }).state;
  assert.equal(stopped.monitoring, 'stopped');
  assert.equal(stopped.stopReason, 'user_stopped');
  assert.equal(stopped.promptPrepared, false);
  assert.ok(transition(started(), { type: 'RESET', now: 1 }).rejected, 'cannot reset a running session');
  const reset = transition(stopped, { type: 'RESET', now: 6 }).state;
  assert.equal(reset.monitoring, 'inactive');
  assert.equal(reset.cycle, 0);
});

test('a running session cannot be started twice', () => {
  assert.match(transition(started(), start()).rejected ?? '', /already running/);
});

test('changing the project stops the running session', () => {
  const r = transition(run(started(), handoff()).state, { type: 'SELECT_PROJECT', projectId: 'p2', now: 4 });
  assert.equal(r.state.projectId, 'p2');
  assert.equal(r.state.monitoring, 'inactive');
  assert.equal(r.state.cycle, 0);
  assert.match(r.state.log.at(-1)?.message ?? '', /Active project changed/);
});

test('closing the tracked tab makes the status unknown', () => {
  const s = run(started(), handoff()).state;
  assert.equal(transition(s, { type: 'TAB_CLOSED', tabId: 99, now: 3 }).state, s, 'other tabs do not matter');
  const closed = transition(s, { type: 'TAB_CLOSED', tabId: TAB, now: 3 }).state;
  assert.equal(closed.trackedTabId, null);
  assert.equal(closed.responseStatus, 'unknown');
});

test('after a browser restart the conversation URL re-binds the new tab', () => {
  const s = run(started(), handoff(), see(obs('generating', '/c/abc|id:1'))).state;
  const restarted = transition(s, { type: 'BROWSER_STARTUP', now: 10 }).state;
  assert.equal(restarted.trackedTabId, null);
  assert.equal(restarted.responseStatus, 'unknown');
  assert.equal(restarted.conversationUrl, CONVO);
  assert.equal(isTrackedObservation(restarted, 501, obs('complete', null, 'https://chatgpt.com/c/zzz')), false);
  const rebound = transition(restarted, see(obs('complete', '/c/abc|id:1'), 11, 501));
  assert.equal(rebound.state.trackedTabId, 501);
  assert.equal(rebound.state.phase, 'needs_review', 'generation seen before the restart still counts');
  assert.equal(rebound.effects.length, 1);
});

test('notified keys and the event log are bounded', () => {
  let s = started();
  for (let i = 0; i < MAX_NOTIFIED_KEYS + 5; i += 1) {
    s = run(s, handoff(null, i * 4), see(obs('generating', `/c/abc|id:${i}`), i * 4 + 1), see(obs('complete', `/c/abc|id:${i}`), i * 4 + 2)).state;
    s = { ...s, cycle: 0, phase: 'ready' };
  }
  assert.equal(s.notifiedResponseKeys.length, MAX_NOTIFIED_KEYS);
  assert.ok(s.log.length <= MAX_LOG_ENTRIES);
});

test('persisted state round-trips and corrupt state recovers to a safe default', () => {
  const s = run(started(), handoff('/c/abc|id:1')).state;
  assert.deepEqual(normalizeWorkflowState(JSON.parse(JSON.stringify(s))), s);
  assert.deepEqual(normalizeWorkflowState(undefined), initialWorkflowState());

  for (const bad of ['x', 42, [], { schemaVersion: 2 }, { schemaVersion: 1, monitoring: 'flying', phase: 'ready' }]) {
    const recovered = normalizeWorkflowState(bad);
    assert.equal(recovered.monitoring, 'inactive', JSON.stringify(bad));
    assert.equal(recovered.recoveredFromCorruption, true);
  }
  const partial = normalizeWorkflowState({ ...s, cycle: -4, responseStatus: 'banana', trackedTabId: 'x', notifiedResponseKeys: [1, 'a'], log: [{ nope: 1 }] });
  assert.equal(partial.cycle, 0);
  assert.equal(partial.responseStatus, 'unknown');
  assert.equal(partial.trackedTabId, null);
  assert.deepEqual(partial.notifiedResponseKeys, ['a']);
  assert.deepEqual(partial.log, []);
});
