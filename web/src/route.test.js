import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoute, parseRoute } from './route.js';

test('round-trips conversation routes, including unusual IDs and account names', () => {
  const route = { view: 'conversation', provider: 'claude', account: 'work & home', id: 'a/b?c#d' };
  const hash = formatRoute(route);
  assert.equal(hash, '#/c/claude/work%20%26%20home/a%2Fb%3Fc%23d');
  assert.deepEqual(parseRoute(hash), route);
});

test('round-trips list routes with search and filters, omitting defaults', () => {
  assert.equal(formatRoute({ view: 'list', provider: 'all', account: 'all', q: '', sort: 'auto' }), '#/');
  const hash = formatRoute({ view: 'list', provider: 'claude', account: 'personal', q: 'react "custom hooks"', sort: 'oldest' });
  assert.deepEqual(parseRoute(hash), { view: 'list', provider: 'claude', account: 'personal', q: 'react "custom hooks"', sort: 'oldest' });
  assert.equal(parseRoute('#/?q=x').sort, 'auto', 'links from before sorting existed');
});

test('treats empty, unknown, and malformed hashes as the default list', () => {
  const list = { view: 'list', provider: 'all', account: 'all', q: '', sort: 'auto' };
  for (const hash of ['', '#', '#/', '#/unknown/path', '#/c/claude', '#/c/%E0%A4%A/x/y']) {
    assert.deepEqual(parseRoute(hash), list, hash);
  }
});

test('round-trips the overview route', () => {
  assert.equal(formatRoute({ view: 'overview' }), '#/overview');
  assert.deepEqual(JSON.parse(JSON.stringify(parseRoute('#/overview'))), { view: 'overview' });
});
