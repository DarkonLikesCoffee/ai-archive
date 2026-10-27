import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveStats, formatBytes } from './archiveStats.js';

const local = (y, m, d) => new Date(y, m, d, 12).toISOString();
const plain = (value) => JSON.parse(JSON.stringify(value));

test('totals conversations, messages, and attachments from the index', () => {
  const stats = archiveStats([
    { provider: 'claude', account: 'personal', model: 'claude-a', message_count: 4, created_at: local(2026, 7, 3), updated_at: local(2026, 9, 1), assets: [{ size: 1000 }, { size: 24 }] },
    { provider: 'claude', account: 'work', model: 'claude-b', message_count: 2, created_at: local(2026, 9, 20), updated_at: local(2026, 9, 21), assets: [] },
    { provider: 'claude', account: 'personal', model: 'claude-a', message_count: 6, created_at: local(2026, 9, 25), updated_at: local(2026, 9, 26) },
  ], { locale: 'en-US' });
  assert.equal(stats.conversations, 3);
  assert.equal(stats.messages, 12);
  assert.equal(stats.attachments, 2);
  assert.equal(stats.attachmentBytes, 1024);
  assert.equal(stats.firstAt, local(2026, 7, 3));
  assert.equal(stats.lastAt, local(2026, 9, 26));
  assert.deepEqual(plain(stats.byMonth), [
    { key: '2026-08', label: 'Aug 2026', count: 1 },
    { key: '2026-09', label: 'Sep 2026', count: 0 },
    { key: '2026-10', label: 'Oct 2026', count: 2 },
  ], 'months run from the first to the last, gaps included');
  assert.deepEqual(plain(stats.byModel), [{ model: 'claude-a', count: 2 }, { model: 'claude-b', count: 1 }]);
  assert.deepEqual(plain(stats.byAccount), [{ account: 'claude · personal', count: 2 }, { account: 'claude · work', count: 1 }]);
});

test('an empty or undated archive has no months', () => {
  assert.deepEqual(plain(archiveStats([])).byMonth, []);
  const undated = archiveStats([{ message_count: 1 }]);
  assert.equal(undated.conversations, 1);
  assert.deepEqual(plain(undated.byMonth), []);
  assert.equal(undated.firstAt, null);
  assert.deepEqual(plain(undated.byModel), [{ model: 'Unknown model', count: 1 }]);
});

test('formats sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(5.5 * 1024 * 1024), '5.5 MB');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
});
