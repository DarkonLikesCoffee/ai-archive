import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import vm from 'node:vm';
import { checkRecoveredOriginals, formatRecoveredOriginalsReport, imageDimensions } from './recoveredOriginals.js';

// Synthetic images only; the archive is written by the real exporter code.
const backgroundSource = await readFile(fileURLToPath(new URL('../../extension/background.js', import.meta.url)), 'utf8');
function loadExporter() {
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } } };
  const context = { chrome, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa: globalThis.btoa, atob: globalThis.atob };
  vm.runInNewContext(`${backgroundSource}\nglobalThis.__hooks = { normalizeAssetList, conversationMarkdown, conversationPath, indexEntry };`, context);
  return context.__hooks;
}
const exporter = loadExporter();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x89, 0, 0, 1, 0xe1]), Buffer.from('synthetic png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 4, 1, 1, 0x11, 0]), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 synthetic preview');

// One conversation with a PNG original, and a JPEG original (named .png by
// Claude) with its WebP preview kept next to it.
function exportedArchive() {
  const id = 'abcd1234-0000-4000-8000-000000000001';
  const asset = (name, bytes, extra) => ({ name, mime: 'image/png', base64: bytes.toString('base64'), size: bytes.length, sha256: sha(bytes), source: 'message', message_external_id: `${id}-u`, ...extra });
  const c = {
    external_id: id, title: 'Images', model: 'm', source_created_at: '2026-11-01T00:00:00.000Z', source_updated_at: '2026-11-01T00:00:00.000Z', message_count: 1,
    messages: [{ external_id: `${id}-u`, role: 'user', content: 'two images', files: [{ file_uuid: 'u1', file_name: '1000_image.png' }, { file_uuid: 'u2', file_name: '2000_image.png' }], attachments: [] }],
    assets: [
      asset('1000_image.png', PNG, { file_uuid: 'u1', mime: 'image/png', detected_extension: 'png', variant: 'original' }),
      asset('2000_image.png', JPEG, { file_uuid: 'u2', mime: 'image/jpeg', detected_extension: 'jpg', variant: 'original' }),
      asset('2000_image.png', WEBP, { file_uuid: 'u2', mime: 'image/webp', detected_extension: 'webp', variant: 'preview', original_sha256: sha(JPEG) }),
    ],
  };
  const normalized = exporter.normalizeAssetList(c, 'claude', 'personal');
  const path = exporter.conversationPath(c, 'claude', 'personal');
  const markdown = exporter.conversationMarkdown(c, 'claude', 'personal', normalized.byKey, normalized.assets);
  const entry = JSON.parse(JSON.stringify(exporter.indexEntry(c, path, 'claude', 'personal', normalized.assets)));
  const files = new Map([[path, Buffer.from(markdown)], ...normalized.assets.map((a) => [a.path, Buffer.from(a.base64, 'base64')])]);
  return {
    index: { version: 2, requires_extension: '0.5.29', conversations: [entry] },
    marker: { format: 'ai-archive', requires_extension: '0.5.29' },
    files,
    recovered: [{ fileName: 'original-abcd1234-1000_image.png', bytes: new Uint8Array(PNG) }, { fileName: 'original-abcd1234-2000_image.jpg', bytes: new Uint8Array(JPEG) }],
  };
}
const run = (archive) => checkRecoveredOriginals({
  index: archive.index, marker: archive.marker, recovered: archive.recovered,
  readFile: async (path) => new Uint8Array(archive.files.get(path)),
  readText: async (path) => archive.files.get(path).toString('utf8'),
});
const failed = (result) => result.sections.flatMap((s) => s.checks.filter((c) => !c.ok).map((c) => c.label));

test('an archive the exporter wrote with the recovered originals passes every check', async () => {
  const result = await run(exportedArchive());
  assert.deepEqual(failed(result), []);
  assert.equal(result.failures, 0);
  const report = formatRecoveredOriginalsReport(result);
  assert.match(report, /abcd1234 2000_image\.\* -> original-abcd1234-2000_image\.jpg \(jpeg, 4x3, 17 bytes\)/);
  assert.match(report, /PASS its preview names this original \(preview_of\)/);
  assert.match(report, /All checks passed\.$/);
  assert.equal(/[0-9a-f]{64}/.test(report), false, 'no hashes are printed');
});

test('each kind of mislabelling is reported', async () => {
  const cases = {
    'the original is not listed as preview-only': (a) => { a.index.conversations[0].preview_only = [{ path: a.index.conversations[0].assets[0].path, name: '1000_image.png', file_uuid: 'u1', reason: 'original-unavailable' }]; },
    'its preview names this original (preview_of)': (a) => { a.index.conversations[0].assets.find((x) => x.variant === 'preview').preview_of = a.index.conversations[0].assets[0].path; },
    'SHA-256 equals the recovered original': (a) => { a.recovered[0] = { ...a.recovered[0], bytes: new Uint8Array(Buffer.concat([PNG, Buffer.from('x')])) }; },
    'exactly one archived original with Claude\'s name': (a) => { a.index.conversations[0].assets[0].variant = 'preview'; },
    'index records requires_extension 0.5.29': (a) => { delete a.index.requires_extension; },
    'no downgrade warning recorded': (a) => { a.marker.downgrade_warning = { detected_at: 't', reason: 'index-rewritten-without-marker' }; },
    'index records the Claude file UUID': (a) => { delete a.index.conversations[0].assets[0].file_uuid; },
  };
  for (const [label, damage] of Object.entries(cases)) {
    const archive = exportedArchive();
    damage(archive);
    const result = await run(archive);
    assert.ok(failed(result).includes(label), `${label}: reported (got ${failed(result).join('; ') || 'nothing'})`);
  }
});

test('JPEG and PNG dimensions are read from the bytes', () => {
  assert.equal(imageDimensions(new Uint8Array(PNG), 'png'), '649x481');
  assert.equal(imageDimensions(new Uint8Array(JPEG), 'jpeg'), '4x3');
});

test('the command-line wrapper reads a local clone and exits 0, 1 or 2', async () => {
  const archive = exportedArchive();
  const root = await mkdtemp(join(tmpdir(), 'recovered-originals-'));
  const repo = join(root, 'repo');
  const folder = join(root, 'recovered');
  for (const [path, bytes] of archive.files) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), bytes);
  }
  await writeFile(join(repo, 'archive/index.json'), JSON.stringify(archive.index));
  await writeFile(join(repo, 'archive/.ai-archive.json'), JSON.stringify(archive.marker));
  await mkdir(folder);
  for (const { fileName, bytes } of archive.recovered) await writeFile(join(folder, fileName), bytes);
  const script = fileURLToPath(new URL('../scripts/verify-recovered-originals.mjs', import.meta.url));
  const exec = (...args) => new Promise((resolve) => execFile(process.execPath, [script, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  const ok = await exec(repo, folder);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /All checks passed\./);
  await writeFile(join(repo, 'archive/index.json'), JSON.stringify({ ...archive.index, requires_extension: undefined }));
  assert.equal((await exec(repo, folder)).code, 1);
  assert.equal((await exec(repo)).code, 2, 'usage error');
});

test('an uploaded JPEG keeps its own name: it is found by its name without the extension', async () => {
  const archive = exportedArchive();
  // As if the JPEG had been uploaded as "holiday.jpg" rather than pasted.
  for (const a of archive.index.conversations[0].assets) if (a.name === '2000_image.png') a.name = 'holiday.jpg';
  archive.recovered[1] = { fileName: 'original-abcd1234-holiday.jpg', bytes: archive.recovered[1].bytes };
  const result = await run(archive);
  assert.deepEqual(failed(result), []);
  assert.match(formatRecoveredOriginalsReport(result), /abcd1234 holiday\.\* -> original-abcd1234-holiday\.jpg/);
});
