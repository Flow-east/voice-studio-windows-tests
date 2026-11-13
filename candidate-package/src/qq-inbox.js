// Read new QQ message events through the public WorldHost event-store contract.
// A placeholder is only a candidate: the audio client must verify the original
// OneBot message contains a record segment before fetching or transcribing it.
const RECORD_PLACEHOLDERS = ['[语音,正在转写中...]', '[语音,协议端不提供转写]'];
const MAX_SEEN = 4096;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function decimal(value, signed = false) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value === 0 || !signed && value < 0) return null;
    return String(value);
  }
  if (typeof value !== 'string' || value.length > 20) return null;
  const pattern = signed ? /^-?[1-9][0-9]{0,18}$/ : /^[1-9][0-9]{0,18}$/;
  return pattern.test(value) ? value : null;
}

function candidate(event) {
  // Check source and type before touching a body or metadata from another World.
  if (!plain(event) || event.source !== 'qq' || event.type !== 'qq.message') return null;
  if (!Number.isSafeInteger(event.cursor) || event.cursor < 1 || !plain(event.meta)) return null;
  const meta = event.meta;
  const messageId = decimal(meta.message_id, true);
  const userId = decimal(meta.user_id);
  const conv = meta.conv;
  if (!messageId || !userId || !plain(conv) || !['group', 'private'].includes(conv.kind) || !decimal(conv.id)) return null;
  if (event.senderKey !== undefined && String(event.senderKey) !== userId) return null;
  if (typeof event.text !== 'string' || !RECORD_PLACEHOLDERS.some(marker => event.text.includes(marker))) return null;
  const senderName = typeof meta.sender_name === 'string'
    ? meta.sender_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
    : '';
  return {
    messageId,
    eventId: event.cursor,
    conv: { kind: conv.kind, id: conv.id },
    userId: meta.user_id,
    senderName: senderName || userId,
  };
}

/**
 * Watch only QQ messages arriving after start(). onVoice is awaited, so a slow
 * transcription provides backpressure instead of building an unbounded queue.
 * stop() aborts the current signal and prevents any later callbacks from that
 * run. Consumers must honour the signal before publishing asynchronous results.
 */
export class QQVoiceInbox {
  constructor({ store, onVoice, onError, intervalMs = 500, batchSize = 100 } = {}) {
    if (!store || typeof store.latestCursor !== 'function' || typeof store.range !== 'function') throw new TypeError('QQVoiceInbox requires an event store.');
    if (typeof onVoice !== 'function') throw new TypeError('QQVoiceInbox requires onVoice.');
    if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function.');
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000) throw new RangeError('intervalMs must be between 1 and 60000.');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError('batchSize must be between 1 and 1000.');
    this.store = store; this.onVoice = onVoice; this.onError = onError;
    this.intervalMs = intervalMs; this.batchSize = batchSize; this.lease = null;
  }

  get running() { return this.lease !== null; }

  latestCursor() {
    const cursor = this.store.latestCursor();
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Event store returned an invalid cursor.');
    return cursor;
  }

  start() {
    if (this.lease) return;
    const lease = { controller: new AbortController(), cursor: this.latestCursor(), seen: new Set(), timer: null };
    this.lease = lease;
    this.schedule(lease, 0);
  }

  stop() {
    const lease = this.lease;
    if (!lease) return;
    this.lease = null;
    if (lease.timer !== null) clearTimeout(lease.timer);
    lease.controller.abort();
    lease.seen.clear();
  }

  active(lease) { return this.lease === lease && !lease.controller.signal.aborted; }

  schedule(lease, delay) {
    if (!this.active(lease)) return;
    lease.timer = setTimeout(() => { lease.timer = null; void this.poll(lease); }, delay);
    lease.timer.unref?.();
  }

  async report(lease, error, voice = null) {
    if (!this.active(lease) || !this.onError) return;
    try { await this.onError(error, voice); } catch { /* A diagnostic callback must not stop the inbox. */ }
  }

  async poll(lease) {
    if (!this.active(lease)) return;
    let nextDelay = this.intervalMs;
    try {
      const latest = this.latestCursor();
      // Clearing the event store must not replay whatever history remains.
      if (latest < lease.cursor) { lease.cursor = latest; lease.seen.clear(); }
      if (latest > lease.cursor) {
        const from = lease.cursor + 1;
        const end = Math.min(latest, lease.cursor + this.batchSize);
        // The SDK's limit takes the *last* N rows. A bounded cursor window is
        // required to avoid skipping earlier records during a busy interval.
        const rows = this.store.range({ source: 'qq', fromCursor: from, toCursor: end, limit: this.batchSize });
        if (!Array.isArray(rows)) throw new TypeError('Event store returned invalid rows.');
        const events = rows.filter(event => plain(event) && Number.isSafeInteger(event.cursor)
          && event.cursor >= from && event.cursor <= end && event.source === 'qq')
          .sort((a, b) => a.cursor - b.cursor);
        for (const event of events) {
          if (!this.active(lease)) return;
          const value = candidate(event);
          if (!value) continue;
          const key = `${value.conv.kind}:${value.conv.id}:${value.messageId}`;
          if (lease.seen.has(key)) continue;
          lease.seen.add(key);
          if (lease.seen.size > MAX_SEEN) lease.seen.delete(lease.seen.values().next().value);
          const voice = { ...value, signal: lease.controller.signal };
          try { await this.onVoice(voice); }
          catch (error) { await this.report(lease, error, voice); }
        }
        if (!this.active(lease)) return;
        lease.cursor = end;
        if (end < latest) nextDelay = 0;
      }
    } catch (error) { await this.report(lease, error); }
    this.schedule(lease, nextDelay);
  }
}
