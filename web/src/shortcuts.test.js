import test from 'node:test';
import assert from 'node:assert/strict';
import { moveFocusIndex, shortcutFor } from './shortcuts.js';

const body = { tagName: 'BODY' };
const input = { tagName: 'INPUT' };
const key = (k, extra = {}) => ({ key: k, target: body, ...extra });

test('maps keys to shortcuts outside fields', () => {
  assert.equal(shortcutFor(key('/')), 'focus-search');
  assert.equal(shortcutFor(key('j')), 'next');
  assert.equal(shortcutFor(key('k')), 'previous');
  assert.equal(shortcutFor(key('Escape')), 'escape');
  assert.equal(shortcutFor(key('x')), null);
  assert.equal(shortcutFor(key('J')), null);
});

test('typing in fields and modified keys are left alone, except Escape', () => {
  for (const target of [input, { tagName: 'textarea' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(shortcutFor(key('/', { target })), null);
    assert.equal(shortcutFor(key('j', { target })), null);
    assert.equal(shortcutFor(key('Escape', { target })), 'leave-field');
  }
  assert.equal(shortcutFor(key('/', { ctrlKey: true })), null);
  assert.equal(shortcutFor(key('k', { metaKey: true })), null);
  assert.equal(shortcutFor(key('j', { altKey: true })), null);
  assert.equal(shortcutFor(key('j', { defaultPrevented: true })), null);
  assert.equal(shortcutFor(key('j', { isComposing: true })), null);
  assert.equal(shortcutFor(null), null);
});

test('moves focus through the list without leaving it', () => {
  assert.equal(moveFocusIndex(-1, 1, 3), 0);
  assert.equal(moveFocusIndex(-1, -1, 3), 2);
  assert.equal(moveFocusIndex(0, 1, 3), 1);
  assert.equal(moveFocusIndex(2, 1, 3), 2);
  assert.equal(moveFocusIndex(0, -1, 3), 0);
  assert.equal(moveFocusIndex(-1, 1, 0), -1);
});
