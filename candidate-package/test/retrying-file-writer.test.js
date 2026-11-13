import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RetryingFileWriter } from '../src/retrying-file-writer.js';

const busy = () => Object.assign(Error('private path'), { code: 'EBUSY', errno: -4082, syscall: 'open' });

test('busy snapshots coalesce without blocking timers or replaying old values', async () => {
  const writer = new RetryingFileWriter({ fileRole: 'setup-log', timeoutMs: 500, intervalMs: 10 });
  let blocked = true, ticks = 0; const writes = [];
  const tick = setInterval(() => ticks++, 5);
  try {
    writer.write(() => { if (blocked) throw busy(); writes.push('first'); });
    for (let value = 0; value < 10000; value++) writer.write(() => { if (blocked) throw busy(); writes.push(value); });
    await delay(40); blocked = false; await writer.flush();
    assert.ok(ticks > 1); assert.deepEqual(writes, [9999]);
    assert.equal(writer.timer, null); assert.equal(writer.action, null); assert.equal(writer.pending, null);
  } finally { clearInterval(tick); }
});

test('new snapshots cannot extend the original busy deadline and failure resets only explicitly', async () => {
  const writer = new RetryingFileWriter({ fileRole: 'engine-state', timeoutMs: 60, intervalMs: 10,
    onError: () => { throw Error('an observer must not crash the timer'); } });
  const action = () => { throw busy(); };
  const start = Date.now(); writer.write(action); const deadline = writer.deadline;
  const update = setInterval(() => { if (!writer.error) writer.write(action); }, 5);
  try {
    await assert.rejects(writer.flush(), error => error.code === 'EBUSY' && error.fileRole === 'engine-state');
    assert.equal(writer.deadline, deadline); assert.ok(Date.now() - start < 500);
    assert.equal(writer.timer, null); assert.equal(writer.pending, null); assert.equal(writer.action, null);
    assert.throws(() => writer.write(() => {}), { code: 'EBUSY' });
    writer.reset(); let saved = false; writer.write(() => { saved = true; }); await writer.flush(); assert.equal(saved, true);
  } finally { clearInterval(update); }
});

test('permission and disk-space errors fail immediately with their file role', async () => {
  for (const code of ['EACCES', 'ENOSPC']) {
    const writer = new RetryingFileWriter({ fileRole: 'setup-log' });
    assert.throws(() => writer.write(() => { throw Object.assign(Error('private'), { code, syscall: 'write' }); }), error => error.code === code && error.fileRole === 'setup-log');
    await assert.rejects(writer.flush(), { code }); assert.equal(writer.pending, null); assert.equal(writer.timer, null);
  }
});

test('cancelling a pending flush clears its timer and cannot resurrect the old snapshot', async () => {
  const writer = new RetryingFileWriter({ fileRole: 'setup-log', intervalMs: 10 });
  let attempts = 0; writer.write(() => { attempts++; throw busy(); });
  const controller = new AbortController(), pending = writer.flush({ signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'USER_CANCELLED' });
  const attemptsAtAbort = attempts; await delay(30);
  assert.equal(attempts, attemptsAtAbort); assert.equal(writer.timer, null); assert.equal(writer.action, null);
  writer.reset(); let value; writer.write(() => { value = 'new'; }); await writer.flush(); assert.equal(value, 'new');
});
