#!/usr/bin/env node
// Read-only integrity audit of an AI Archive GitHub repository (ROADMAP P0.1).
//
//   GITHUB_TOKEN=<read-only token> node web/scripts/verify-archive.mjs <owner>/<repo> \
//     [--branch main] [--markdown] [--hashes] [--rebuild-dry-run] \
//     [--concurrency 6] [--quiet] [--no-progress] [--json]
//
// --markdown downloads every conversation file to check its attachment links
// and "not archived" notes; --hashes downloads every attachment to verify its
// SHA-256 and size; --rebuild-dry-run (implies --markdown) also rebuilds the
// index from the conversation files and reports the differences, writing
// nothing. Downloads run --concurrency at a time (default 6) with retries.
// Progress goes to stderr; the report (or JSON with --json) to stdout.
// Only GET requests are made, only to api.github.com. Nothing is written,
// repaired or deleted. Exit status: 0 no errors, 1 errors found, 2 could not
// run, 130 interrupted (Ctrl+C).
import { runVerifier } from '../src/verifyArchiveCli.js';

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts += 1;
  if (interrupts > 1) process.exit(130);
  process.stderr.write('\nStopping: no new downloads are started; press Ctrl+C again to quit at once.\n');
  controller.abort();
});

const status = await runVerifier({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: globalThis.fetch,
  stdout: process.stdout,
  stderr: process.stderr,
  stderrIsTTY: Boolean(process.stderr.isTTY),
  signal: controller.signal,
});
process.exitCode = status;
