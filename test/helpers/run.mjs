// Test helpers: temporary folders and running programs in a child Node process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function tempDir(prefix = 'vb-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

// Name of the uncaught error Node printed (e.g. "ReferenceError"), or null.
export function uncaughtName(stderr) {
  const m = /^(?:Uncaught )?([A-Z][A-Za-z]*(?:Error|Exception))\b/m.exec(stderr);
  return m ? m[1] : null;
}

/** Runs `node file` and returns { stdout, status, error } (error = name of an uncaught error). */
export function runNode(file, { cwd, args = [], timeout = 15000 } = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', ...args, file], { cwd: cwd || path.dirname(file), encoding: 'utf8', timeout });
  if (r.error) throw r.error;
  return { stdout: r.stdout.replace(/\r\n/g, '\n'), status: r.status, error: r.status === 0 ? null : uncaughtName(r.stderr), stderr: r.stderr };
}
