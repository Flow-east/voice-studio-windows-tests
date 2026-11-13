// Setup logs and progress are small snapshots. A Windows sharing conflict may
// outlive one event-loop turn, so retry it without blocking the host or queueing
// every progress event. The deadline belongs to the first failure, not updates.
export function fileOperationError(error, fileRole) {
  if (!error || typeof error !== 'object') error = Error(String(error));
  error.fileRole = fileRole;
  return error;
}

export class RetryingFileWriter {
  constructor({ fileRole, platform = process.platform, timeoutMs = 3000, intervalMs = 100, onError } = {}) {
    this.fileRole = fileRole; this.platform = platform; this.timeoutMs = timeoutMs; this.intervalMs = intervalMs; this.onError = onError;
    this.pending = null; this.error = null; this.action = null; this.timer = null;
  }
  write(action) {
    if (this.error) throw this.error;
    this.action = action;
    if (this.pending) return;
    try { this.action(); this.action = null; }
    catch (error) {
      error = fileOperationError(error, this.fileRole);
      if (!this.isRetryable(error)) { this.error = error; this.action = null; throw error; }
      this.deadline = Date.now() + this.timeoutMs;
      this.pending = new Promise(resolve => { this.resolvePending = resolve; });
      this.schedule();
    }
  }
  isRetryable(error) {
    if (error?.code === 'EBUSY' || error?.errno === -4082) return true;
    // Windows reports EPERM for rename-over an exclusively opened state file.
    // It can also mean a real ACL denial: only retry this specific snapshot
    // operation, keep the same deadline, and preserve EPERM if it never clears.
    return this.platform === 'win32' && this.fileRole === 'engine-state' && error?.code === 'EPERM' && error?.syscall === 'rename';
  }
  schedule() {
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.action(); this.settle(); }
      catch (error) {
        error = fileOperationError(error, this.fileRole);
        if (this.isRetryable(error) && Date.now() < this.deadline) return this.schedule();
        this.error = error; this.settle();
        // Timer callbacks must never leak an exception into the host. The
        // stored failure is still observed by every flush, even without a hook.
        try { this.onError?.(error); } catch { /* observed by flush */ }
      }
    }, Math.max(0, Math.min(this.intervalMs, this.deadline - Date.now())));
  }
  settle() {
    clearTimeout(this.timer); this.timer = null; this.action = null;
    const resolve = this.resolvePending; this.resolvePending = null; this.pending = null; resolve?.();
  }
  async flush({ signal } = {}) {
    const abort = () => {
      if (!this.pending) return;
      this.error = Object.assign(Error('准备已取消'), { code: 'USER_CANCELLED' });
      this.settle();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      while (this.pending) await this.pending;
      if (this.error) throw this.error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  reset() {
    if (this.pending) throw Error('文件写入仍在等待');
    this.error = null; this.action = null;
  }
}
