// Short-lived controlled fixtures. Never observes or terminates other apps.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, directory] = process.argv.slice(2);
if (!directory || !['tree', 'exit-clean', 'exit-with-descendant', 'paused-stdio', 'exit-with-independent-descendant', 'supervisor-killed', 'supervisor-stdin-eof', 'leaf'].includes(mode)) process.exit(2);
const file = name => join(directory, name);
const leaf = mode === 'leaf';
process.on('uncaughtException', () => process.exit(3));
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
writeFileSync(file(leaf ? 'leaf.pid' : 'parent.pid'), String(process.pid));
if (mode === 'tree' || mode === 'exit-with-descendant' || mode === 'exit-with-independent-descendant' || mode === 'supervisor-killed' || mode === 'supervisor-stdin-eof') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf', directory], {
    stdio: mode === 'exit-with-independent-descendant' ? 'ignore' : ['ignore', 'inherit', 'inherit'], windowsHide: true, shell: false,
    // Only this orphan control must outlive the parent's libuv Job object.
    // The leaf still obeys its own stop file and 15-second maximum lifetime.
    detached: mode === 'exit-with-descendant' || mode === 'exit-with-independent-descendant',
  });
  child.unref();
}
writeFileSync(file(leaf ? 'leaf.ready' : 'parent.ready'), 'ready');
process.stdout.write('FIXTURE_READY\n');
setInterval(() => {
  writeFileSync(file(leaf ? 'leaf.heartbeat' : 'parent.heartbeat'), String(Date.now()));
  if (existsSync(file(leaf ? 'stop-leaf' : 'stop-parent'))) process.exit(0);
  if ((mode === 'exit-clean' || mode === 'exit-with-descendant' || mode === 'exit-with-independent-descendant') && existsSync(file('exit-parent'))) process.exit(0);
  if (mode === 'paused-stdio') process.stdout.write(Buffer.alloc(65536, 120));
  else if (leaf) process.stdout.write('.');
}, 20);
// Cleanup safety if the harness is interrupted: these are never persistent.
setTimeout(() => process.exit(0), 15000);
