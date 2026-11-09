import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditArchive, formatAuditReport, isConversationMarkdownPath } from './archiveIntegrity.js';
import { planIndexRebuild, formatRebuildPlan, rebuildIndexEntry } from './indexRebuild.js';
import { parseConversationMarkdown } from './github.js';
import { runVerifier } from './verifyArchiveCli.js';

// Synthetic archive shapes only (no real conversation data).
const ROOT = 'archive/conversations/claude';
const bytes = (text) => Buffer.from(text);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const gitSha = (data) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex');
const ID = '12340000-0000-4000-8000-000000000001';
const meta = (account) => ({ id: ID, provider: 'claude', account, title: 'T', model: null, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z', message_count: 2 });
const current = (account) => `<!-- AI_ARCHIVE_METADATA\n${JSON.stringify(meta(account), null, 2)}\n-->\n\n# T\n\n## You\n\nhi\n\n---\n\n## Claude\n\nhello\n`;
// The earliest exporter: JSON front matter between --- lines, file named by UUID.
const legacy = (account) => `---\n${JSON.stringify(meta(account), null, 2)}\n---\n\n# T\n\n## You\n\nhi\n\n---\n\n## Claude\n\nhello\n`;
const treeOf = (files) => [...files].map(([path, data]) => ({ path, type: 'blob', sha: gitSha(data), size: data.length }));

test('the earliest exporter\'s --- JSON front matter is read as metadata; a plain leading rule is not', () => {
  const parsed = parseConversationMarkdown(legacy('personal'));
  assert.equal(parsed.id, ID);
  assert.equal(parsed.account, 'personal');
  assert.deepEqual(parsed.messages.map((m) => m.role), ['user', 'assistant']);
  const rule = parseConversationMarkdown('---\n\n# Notes\n\n## You\n\nhi\n');
  assert.equal(rule.id, undefined, 'a horizontal rule is not front matter');
  const notJson = parseConversationMarkdown('---\n{ not json }\n---\n\n# X\n');
  assert.equal(notJson.id, undefined);
});

test('Markdown files under assets/ are attachments, not conversations', async () => {
  assert.equal(isConversationMarkdownPath(`${ROOT}/acct/T--${ID}.md`), true);
  assert.equal(isConversationMarkdownPath(`${ROOT}/acct/assets/${ID}-abc/1234abcd-README.md`), false);
  const readme = bytes('# Project\n\nSee ![diagram](assets/nowhere/x.png)\n');
  const md = bytes(current('acct'));
  const files = new Map([
    [`${ROOT}/acct/T--${ID}.md`, md],
    [`${ROOT}/acct/assets/${ID}-abc/1234abcd-README.md`, readme],
    ['archive/index.json', bytes('{}')],
  ]);
  const index = { conversations: [{ ...meta('acct'), path: `${ROOT}/acct/T--${ID}.md`, assets: [{ path: `${ROOT}/acct/assets/${ID}-abc/1234abcd-README.md`, sha256: sha(readme), size: readme.length, name: 'README.md' }] }] };
  const markdown = new Map([...files].filter(([p]) => p.endsWith('.md')).map(([p, b]) => [p, b.toString()]));
  const result = await auditArchive({ index, tree: treeOf(files), markdown });
  assert.equal(result.checked.markdownFiles, 1, 'only the conversation file is checked as a conversation');
  assert.equal(result.findings.length, 0, 'the README\'s own links are not attachment references');
  const plan = await planIndexRebuild({ index, tree: treeOf(files), markdown });
  assert.equal(plan.rebuilt, 1);
  assert.deepEqual(plan.unreadable, [], 'the README is not an unreadable conversation');
});

test('rebuilding ignores attachment links quoted in fenced or inline code', async () => {
  const own = bytes('png bytes');
  const ownPath = `${ROOT}/acct/assets/${ID}-abc/aaaa1111-photo.png`;
  const text = `${current('acct')}\n![photo.png](assets/${ID}-abc/aaaa1111-photo.png)\n\n\`\`\`md\n![quoted](assets/aa00bb11/cc22dd33-script.js)\n\`\`\`\nAnd inline: \`![x](assets/ee44ff55/66778899-photo.jpg)\`\n`;
  const files = new Map([[`${ROOT}/acct/T--${ID}.md`, bytes(text)], [ownPath, own], ['archive/index.json', bytes('{}')]]);
  const { entry, problems } = await rebuildIndexEntry({ path: `${ROOT}/acct/T--${ID}.md`, markdown: text, tree: treeOf(files) });
  assert.deepEqual(problems, [], 'quoted links are not missing attachments');
  assert.deepEqual(entry.assets.map((a) => [a.path, a.name]), [[ownPath, 'photo.png']]);
  const index = { conversations: [{ ...entry, assets: [{ path: ownPath, sha256: sha(own), size: own.length, name: 'photo.png' }] }] };
  const plan = await planIndexRebuild({ index, tree: treeOf(files), markdown: new Map([[`${ROOT}/acct/T--${ID}.md`, text]]) });
  assert.deepEqual(plan.differs, [], 'the conversation matches its index entry');
  // A real missing attachment outside code is still reported.
  const broken = `${current('acct')}\n![gone](assets/${ID}-abc/0000-gone.png)\n`;
  assert.deepEqual((await rebuildIndexEntry({ path: `${ROOT}/acct/T--${ID}.md`, markdown: broken, tree: treeOf(files) })).problems,
    [`links to assets/${ID}-abc/0000-gone.png, which is not in the repository`]);
});

test('a copy of a conversation indexed under another account is named as such, in the audit and the rebuild plan', async () => {
  const indexedPath = `${ROOT}/dddd/T--${ID}.md`;
  const files = new Map([
    [indexedPath, bytes(current('dddd'))],
    [`${ROOT}/bbbb/T--${ID}.md`, bytes(current('bbbb'))], // current format, other account
    [`${ROOT}/personal/${ID}.md`, bytes(legacy('personal'))], // earliest format, other account
    ['archive/index.json', bytes('{}')],
  ]);
  const index = { conversations: [{ ...meta('dddd'), path: indexedPath, assets: [] }] };
  const markdown = new Map([...files].filter(([p]) => p.endsWith('.md')).map(([p, b]) => [p, b.toString()]));
  const result = await auditArchive({ index, tree: treeOf(files), markdown });
  const unref = Object.fromEntries(result.findings.filter((f) => f.code === 'file-unreferenced').map((f) => [f.path, f]));
  for (const path of [`${ROOT}/bbbb/T--${ID}.md`, `${ROOT}/personal/${ID}.md`]) {
    assert.equal(unref[path].kind, 'indexed-under-other-account', path);
    assert.match(unref[path].message, new RegExp(`indexed under account "dddd" at ${indexedPath.replace(/[.]/g, '\\.')}`));
    assert.equal(unref[path].severity, 'warning', 'still reported, not hidden');
  }
  assert.match(formatAuditReport(result), /2 copies of conversations indexed under another account:/);
  const plan = await planIndexRebuild({ index, tree: treeOf(files), markdown });
  assert.deepEqual(plan.unreadable, [], 'the earliest format is readable now');
  assert.deepEqual(plan.onlyInFiles.map((item) => [item.path, item.indexedUnder]), [
    [`${ROOT}/bbbb/T--${ID}.md`, [{ account: 'dddd', path: indexedPath }]],
    [`${ROOT}/personal/${ID}.md`, [{ account: 'dddd', path: indexedPath }]],
  ]);
  assert.match(formatRebuildPlan(plan), /NOT IN INDEX .*bbbb.* \(already indexed under account "dddd"; adding it would index a second copy\)/);
});

test('the command downloads conversation Markdown only; Markdown attachments are hashed with the attachments', async () => {
  const readme = bytes('# readme');
  const md = bytes(current('acct'));
  const readmePath = `${ROOT}/acct/assets/${ID}-abc/1234abcd-README.md`;
  const files = new Map([[`${ROOT}/acct/T--${ID}.md`, md], [readmePath, readme]]);
  const index = { version: 2, conversations: [{ ...meta('acct'), path: `${ROOT}/acct/T--${ID}.md`, assets: [{ path: readmePath, sha256: sha(readme), size: readme.length, name: 'README.md' }] }] };
  files.set('archive/index.json', bytes(JSON.stringify(index)));
  const blobs = new Map([...files.values()].map((b) => [gitSha(b), b]));
  const requested = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname.replace('/repos/o/r', '');
    const reply = (status, body) => ({ ok: status < 300, status, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json') : null) }, text: async () => (Buffer.isBuffer(body) ? body.toString() : JSON.stringify(body)), arrayBuffer: async () => Uint8Array.from(body).buffer });
    if (path === '/git/ref/heads/main') return reply(200, { object: { sha: 'c'.repeat(40) } });
    if (path.startsWith('/git/commits/')) return reply(200, { tree: { sha: 't' } });
    if (path.startsWith('/git/trees/')) return reply(200, { truncated: false, tree: treeOf(files) });
    const m = path.match(/^\/git\/blobs\/(.+)$/);
    if (m) { requested.push(m[1]); return reply(200, blobs.get(m[1])); }
    return reply(404, { message: 'Not Found' });
  };
  const out = { t: '', write(s) { this.t += s; } };
  const status = await runVerifier({ argv: ['o/r', '--markdown', '--json', '--quiet'], env: { GITHUB_TOKEN: 'x' }, fetch, stdout: out, stderr: { write() {} }, sleep: async () => {} });
  assert.equal(status, 0);
  assert.equal(JSON.parse(out.t).checked.markdownFiles, 1);
  assert.equal(requested.includes(gitSha(readme)), false, 'the README is not downloaded as a conversation');
});

test('an unclosed code block in one message does not turn later attachment links into code', async () => {
  const own = bytes('png bytes');
  const ownPath = `${ROOT}/acct/assets/${ID}-abc/aaaa1111-photo.png`;
  const text = `${current('acct')}`.replace('hello\n', 'hello, an unbalanced fence follows\n\n```js\nconst open = true;\n')
    + `\n---\n\n## You\n\n![photo.png](assets/${ID}-abc/aaaa1111-photo.png)\n\nnext question\n`;
  const { scanAssetLinks } = await import('./archiveIntegrity.js');
  assert.deepEqual(scanAssetLinks(text).map((l) => [l.ref, l.inCode]), [[`assets/${ID}-abc/aaaa1111-photo.png`, false]]);
  const files = new Map([[`${ROOT}/acct/T--${ID}.md`, bytes(text)], [ownPath, own]]);
  const { entry, problems } = await rebuildIndexEntry({ path: `${ROOT}/acct/T--${ID}.md`, markdown: text, tree: treeOf(files) });
  assert.deepEqual(problems, []);
  assert.deepEqual(entry.assets.map((a) => a.path), [ownPath]);
  // An exporter link after an unclosed fence in the same message still counts:
  // the file exists in the conversation's own folder.
  const sameMessage = `${current('acct')}`.replace('hello\n', `hello\n\n\`\`\`js\nunclosed\n\n![photo.png](assets/${ID}-abc/aaaa1111-photo.png)\n`);
  const again = await rebuildIndexEntry({ path: `${ROOT}/acct/T--${ID}.md`, markdown: sameMessage, tree: treeOf(files) });
  assert.deepEqual(again.entry.assets.map((a) => a.path), [ownPath]);
});
