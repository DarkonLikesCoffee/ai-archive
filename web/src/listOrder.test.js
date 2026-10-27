import test from 'node:test';
import assert from 'node:assert/strict';
import { dateGroupLabel, effectiveSort, groupByDate, sortConversations, sortOptions } from './listOrder.js';

const now = new Date(2026, 9, 27, 15, 0).getTime();
const local = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();

test('date group labels use calendar days in local time', () => {
  assert.equal(dateGroupLabel(local(2026, 9, 27, 0), now), 'Today');
  assert.equal(dateGroupLabel(local(2026, 9, 28), now), 'Today', 'a clock-skewed future date');
  assert.equal(dateGroupLabel(local(2026, 9, 26, 23), now), 'Yesterday');
  assert.equal(dateGroupLabel(local(2026, 9, 21), now), 'Previous 7 days');
  assert.equal(dateGroupLabel(local(2026, 9, 20), now), 'Previous 30 days');
  assert.equal(dateGroupLabel(local(2026, 8, 28), now), 'Previous 30 days');
  assert.equal(dateGroupLabel(local(2026, 8, 27), now, 'en-US'), 'September 2026');
  assert.equal(dateGroupLabel(local(2025, 0, 5), now, 'en-US'), 'January 2025');
  assert.equal(dateGroupLabel(null, now), 'No date');
  assert.equal(dateGroupLabel('not a date', now), 'No date');
});

test('auto sort is relevance while searching and recently updated otherwise', () => {
  assert.equal(effectiveSort('auto', true), 'auto');
  assert.equal(effectiveSort('auto', false), 'updated');
  assert.equal(effectiveSort('title', true), 'title');
  assert.equal(effectiveSort('bogus', false), 'updated');
  assert.deepEqual(sortOptions(false).map((o) => o.label), ['Recently updated', 'Recently created', 'Oldest first', 'Title A–Z']);
  assert.deepEqual(sortOptions(true).map((o) => o.label), ['Best match', 'Recently updated', 'Recently created', 'Oldest first', 'Title A–Z']);
});

const conversations = [
  { id: 'a', title: 'beta', created_at: local(2026, 0, 1), updated_at: local(2026, 9, 27, 10) },
  { id: 'b', title: 'Alpha 10', created_at: local(2026, 8, 1), updated_at: local(2026, 8, 2) },
  { id: 'c', title: 'alpha 9', created_at: null, updated_at: null },
  { id: 'd', title: 'Gamma', created_at: local(2025, 4, 1), updated_at: local(2026, 9, 26, 10) },
];
const ids = (xs) => xs.map((x) => x.id).join('');

test('sorts by updated, created, oldest and title, with undated last', () => {
  assert.equal(ids(sortConversations(conversations, 'updated')), 'adbc');
  assert.equal(ids(sortConversations(conversations, 'created')), 'badc');
  assert.equal(ids(sortConversations(conversations, 'oldest')), 'dabc');
  assert.equal(ids(sortConversations(conversations, 'title')), 'cbad', 'case-insensitive and numeric-aware');
  assert.equal(ids(sortConversations(conversations, 'auto')), 'abcd', 'auto keeps the search ranking');
  assert.equal(ids(conversations), 'abcd', 'the input is not mutated');
});

test('groups consecutive conversations by the date the sort uses', () => {
  const at = now;
  const groups = groupByDate(sortConversations(conversations, 'updated'), 'updated', { now: at, locale: 'en-US' });
  assert.deepEqual(groups.map((g) => `${g.label}:${ids(g.items)}`), ['Today:a', 'Yesterday:d', 'September 2026:b', 'No date:c']);
  const created = groupByDate(sortConversations(conversations, 'oldest'), 'oldest', { now: at, locale: 'en-US' });
  assert.deepEqual(created.map((g) => g.label), ['May 2025', 'January 2026', 'September 2026', 'No date']);
  assert.equal(groupByDate(conversations, 'title'), null);
  assert.equal(groupByDate(conversations, 'auto'), null);
});
