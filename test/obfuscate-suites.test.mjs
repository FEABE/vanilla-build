// Runs another project's own test suite against obfuscated builds of its modules, via scripts/obfuscate-suites.mjs
// (which uses scripts/obfuscate-hook.cjs to swap each source file for its obfuscated version at load time, without
// touching that project). Skips cleanly when the sibling repositories are not checked out. The full ">= 30 seeds"
// sweep is a separate manual/CI run (see the README); here one seed per configuration is enough to guard wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = path.join(HERE, '..', 'scripts', 'obfuscate-suites.mjs');
const resolveRepo = (env, rel) => {
  const dir = process.env[env] ? path.resolve(process.env[env]) : path.resolve(HERE, '..', '..', rel);
  return fs.existsSync(path.join(dir, 'test')) ? dir : null;
};
const kit = resolveRepo('VB_OBF_KIT', 'vanilla-kit');
const arch = resolveRepo('VB_OBF_ARCH', 'vanilla-arch');

test('suite rerun: vanilla-kit and vanilla-arch suites pass against obfuscated builds', { skip: (!kit && !arch) && 'sibling repos not present', timeout: 300000 }, () => {
  const args = [SWEEP, '--seeds', '1', '--jobs', '4'];
  if (kit) args.push('--kit', kit);
  if (arch) args.push('--arch', arch);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 290000 });
  assert.equal(r.status, 0, 'sweep reported a failure:\n' + (r.stdout || '') + (r.stderr || ''));
  // positive control: the hook really replaced source files, and the suite baselines were non-empty.
  if (kit) assert.match(r.stdout, /baseline kit: pass [1-9]/, r.stdout);
  if (arch) assert.match(r.stdout, /baseline arch: pass [1-9]/, r.stdout);
});
