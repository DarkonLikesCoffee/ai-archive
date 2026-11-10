#!/usr/bin/env node
// Read-only check for the controlled live test of original-first images.
//
//   node web/scripts/verify-recovered-originals.mjs <clone-of-the-test-archive> <folder-with-recovered-files>
//
// <clone-of-the-test-archive>: a local clone of the separate TEST repository
// the extension synced to (never the real archive). <folder-with-recovered-
// files>: the originals recovered by hand, named
// original-<conversation 8 chars>-<stem>.<png|jpg|jpeg>.
// See docs/live-test-original-images.md.
//
// Reads local files only: no network requests, nothing written. Prints
// PASS/FAIL per check, never image bytes or hashes. Exit status: 0 all
// checks passed, 1 a check failed, 2 could not run.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkRecoveredOriginals, formatRecoveredOriginalsReport, RECOVERED_NAME } from '../src/recoveredOriginals.js';

const [repo, folder] = process.argv.slice(2);
if (!repo || !folder) {
  process.stderr.write('Usage: node web/scripts/verify-recovered-originals.mjs <clone-of-the-test-archive> <folder-with-recovered-files>\n');
  process.exit(2);
}

let index;
try {
  index = JSON.parse(readFileSync(join(repo, 'archive/index.json'), 'utf8'));
} catch (error) {
  process.stderr.write(`Cannot read ${join(repo, 'archive/index.json')}: ${error.message}\n`);
  process.exit(2);
}
let marker = null;
const markerPath = join(repo, 'archive/.ai-archive.json');
try { marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null; } catch { marker = { unreadable: true }; }

let names;
try {
  names = readdirSync(folder).filter((name) => RECOVERED_NAME.test(name));
} catch (error) {
  process.stderr.write(`Cannot read ${folder}: ${error.message}\n`);
  process.exit(2);
}
if (!names.length) {
  process.stderr.write('No recovered files named original-<8 characters>-<name>.<png|jpg> in that folder.\n');
  process.exit(2);
}

try {
  const result = await checkRecoveredOriginals({
    index,
    marker,
    recovered: names.map((fileName) => ({ fileName, bytes: new Uint8Array(readFileSync(join(folder, fileName))) })),
    readFile: async (path) => new Uint8Array(readFileSync(join(repo, path))),
    readText: async (path) => readFileSync(join(repo, path), 'utf8'),
  });
  process.stdout.write(`${formatRecoveredOriginalsReport(result)}\n`);
  process.exit(result.failures ? 1 : 0);
} catch (error) {
  process.stderr.write(`Could not complete the check: ${error.message}\n`);
  process.exit(2);
}
