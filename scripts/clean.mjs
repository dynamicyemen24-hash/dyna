/**
 * Removes build output. Cross-platform.
 *
 * ══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
 * `clean` used to be `rm -rf dist dist-server`.
 *
 * `rm` is not an executable on Windows. It is a coreutils binary that ships
 * with Git Bash and WSL, not with `cmd.exe` or PowerShell — and npm runs
 * scripts through the platform shell. On the machine this project is actually
 * developed and operated on, `npm run clean` failed outright:
 *
 *     'rm' is not recognized as an internal or external command
 *
 * That is not a cosmetic problem. A clean step that cannot run means a stale
 * `dist/` survives into the next build and then into the deployment, and the
 * symptom — "the fix is deployed but the old behaviour is still there" — sends
 * the investigation into the application code, where the bug is not.
 *
 * ══ WHY THIS IS PLAIN NODE ═════════════════════════════════════════════════
 * `fs.rmSync(dir, { recursive: true, force: true })` is available in the Node
 * version this project already requires, so the script needs no dependency and
 * no shell. `force: true` makes a missing directory a no-op rather than an
 * error, which is what a clean step should do when there is nothing to clean.
 *
 * The guard below is deliberate: this deletes directories recursively. It will
 * only remove paths inside the project root and never a root-level `.` or `..`,
 * so a bad argument cannot turn a clean into a self-deletion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Build output only. Never `src`, `server` or `.env`. */
const TARGETS = ['dist', 'dist-server'];

for (const target of TARGETS) {
  const full = path.resolve(ROOT, target);

  // Refuse anything that escapes the project, or that is the project itself.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    console.error(`refusing to remove ${full}: outside the project root`);
    process.exit(1);
  }

  if (!fs.existsSync(full)) {
    console.log(`skip    ${target} (not present)`);
    continue;
  }

  fs.rmSync(full, { recursive: true, force: true });
  console.log(`removed ${target}`);
}