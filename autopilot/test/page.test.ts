import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, observePage, readSignals } from '../src/content/page.ts';
import { DEFAULT_SELECTORS, type SelectorConfig } from '../src/content/selectors.ts';
import { CONVO, fakePage, fakeRoot, signals } from './helpers/fixtures.ts';

test('classification order: usage limit, generating, error, unknown, complete/idle', () => {
  assert.equal(classify(signals({ usageLimitNoticeFound: true, stopControlFound: true })), 'usage_limit');
  assert.equal(classify(signals({ stopControlFound: true, errorNoticeFound: true })), 'generating');
  assert.equal(classify(signals({ streamingMarkerFound: true })), 'generating');
  assert.equal(classify(signals({ errorNoticeFound: true, assistantMessageCount: 2 })), 'error');
  assert.equal(classify(signals({ composerFound: false, assistantMessageCount: 3 })), 'unknown');
  assert.equal(classify(signals({ assistantMessageCount: 1 })), 'complete');
  assert.equal(classify(signals()), 'idle');
});

test('a visible stop control means generating', () => {
  const o = observePage(fakePage({ stop: true, assistantIds: ['m1'] }), CONVO, DEFAULT_SELECTORS);
  assert.equal(o.status, 'generating');
  assert.equal(o.responseKey, '/c/abc|id:m1');
});

test('a hidden stop control is ignored', () => {
  const root = fakeRoot({ [DEFAULT_SELECTORS.composer[0]!]: [{}], [DEFAULT_SELECTORS.stopControl[0]!]: [{ visible: false }] });
  assert.equal(observePage(root, CONVO, DEFAULT_SELECTORS).status, 'idle');
});

test('any configured stop selector is recognized', () => {
  const root = fakeRoot({ '#prompt-textarea': [{}], 'button[aria-label="Stop streaming"]': [{}] });
  assert.equal(observePage(root, CONVO, DEFAULT_SELECTORS).status, 'generating');
});

test('after generation the latest assistant message gives the response key', () => {
  const o = observePage(fakePage({ send: true, assistantIds: ['m1', 'm2'] }), CONVO, DEFAULT_SELECTORS);
  assert.equal(o.status, 'complete');
  assert.equal(o.responseKey, '/c/abc|id:m2');
  const noIds = observePage(fakePage({ assistantIds: [null, null, null] }), CONVO, DEFAULT_SELECTORS);
  assert.equal(noIds.responseKey, '/c/abc|n:3');
});

test('a page without a recognizable composer reports unknown, not complete', () => {
  const o = observePage(fakePage({ composer: false, assistantIds: ['m1'] }), CONVO, DEFAULT_SELECTORS);
  assert.equal(o.status, 'unknown');
  assert.equal(observePage(fakeRoot({}), CONVO, DEFAULT_SELECTORS).status, 'unknown');
});

test('usage-limit notices are detected', () => {
  for (const text of [
    "You've hit the Free plan limit for GPT-5. Responses will use another model until your limit resets after 4:12 PM.",
    "You’ve reached our limit of messages per hour. Please try again later.",
    'Too many requests in 1 hour. Try again later.',
    'You have reached your usage cap.',
  ]) {
    const o = observePage(fakePage({ assistantIds: ['m1'], notices: [{ text }] }), CONVO, DEFAULT_SELECTORS);
    assert.equal(o.status, 'usage_limit', text);
  }
});

test('error notices are detected', () => {
  for (const text of ['Something went wrong. If this issue persists please contact us.', 'There was an error generating a response', 'Network error']) {
    const o = observePage(fakePage({ assistantIds: ['m1'], notices: [{ text }] }), CONVO, DEFAULT_SELECTORS);
    assert.equal(o.status, 'error', text);
  }
});

test('words inside conversation messages are not mistaken for notices', () => {
  const root = fakePage({
    assistantIds: ['m1'],
    notices: [{ text: 'Rate limit handling: you have reached the usage limit when…', insideMessage: true }, { text: 'Something went wrong', insideMessage: true }],
  });
  assert.equal(observePage(root, CONVO, DEFAULT_SELECTORS).status, 'complete');
});

test('long texts and hidden notices are not treated as notices', () => {
  const long = fakePage({ assistantIds: ['m1'], notices: [{ text: `usage limit ${'x'.repeat(700)}` }] });
  assert.equal(observePage(long, CONVO, DEFAULT_SELECTORS).status, 'complete');
  const hidden = fakePage({ assistantIds: ['m1'], notices: [{ text: 'Too many requests', visible: false }] });
  assert.equal(observePage(hidden, CONVO, DEFAULT_SELECTORS).status, 'complete');
});

test('an invalid selector matches nothing instead of breaking detection', () => {
  const selectors: SelectorConfig = { ...DEFAULT_SELECTORS, stopControl: ['!!invalid', ...DEFAULT_SELECTORS.stopControl] };
  const o = observePage(fakePage({ stop: true }), CONVO, selectors);
  assert.equal(o.status, 'generating');
});

test('observations carry no message text', () => {
  const root = fakeRoot({
    '#prompt-textarea': [{}],
    '[data-message-author-role="assistant"]': [{ text: 'SECRET ANSWER TEXT', attrs: { 'data-message-id': 'm9' } }],
  });
  const o = observePage(root, CONVO, DEFAULT_SELECTORS);
  assert.doesNotMatch(JSON.stringify(o), /SECRET/);
  assert.equal(readSignals(root, DEFAULT_SELECTORS).signals.assistantMessageCount, 1);
});
