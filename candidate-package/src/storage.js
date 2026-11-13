import { lstat, realpath, readdir, readFile, readlink, unlink, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { StudioError } from './config.js';

const MODEL_IDS = ['asr', 'speech', 'reference', 'singing'];
const MODEL_LABELS = { asr: 'QQ 语音识别', speech: '旧版说话模型', reference: '语音合成（默认与参考音色共用）', singing: '唱歌模型' };
const CACHE_PATHS = ['engine-v1/uv-cache', 'engine-v1/hf-cache', 'engine-v1/uv.tar.gz', 'engine-v1/uv.zip', 'engine-v1/ace.tar.gz', 'engine-v1/uv-stage', 'engine-v1/ace-source-stage', 'cache'];
const RUNTIME_PATHS = ['engine-v1/python', 'engine-v1/speech-env', 'engine-v1/asr-env', 'engine-v1/singing-env', 'engine-v1/ace-source', 'engine-v1/bin'];
const JOB_ID = /^\d{13}-[a-f0-9]{8}$/;
const KINDS = ['speech', 'song', 'transcription'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const plans = new WeakMap();
const inside = (root, path) => { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a);
const pathMatches = (path, base) => path === base || path.startsWith(base + '/');
const safeError = () => new StudioError('存储目录已变化或不安全，请刷新后重试。');
const identity = s => `${s.dev}:${s.ino}`;
async function maybeStat(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function rootInfo(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw safeError();
  const given = await lstat(root); if (!given.isDirectory() || given.isSymbolicLink()) throw safeError();
  const path = await realpath(root), stat = await lstat(path);
  return { path, identity: identity(stat) };
}
async function checkedPath(base, rel, allowLeafLink = false, expectedRootIdentity) {
  if (expectedRootIdentity) {
    const root = await maybeStat(base);
    if (!root?.isDirectory() || root.isSymbolicLink() || identity(root) !== expectedRootIdentity) throw safeError();
  }
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\\') || rel.split('/').some(x => !x || x === '.' || x === '..')) throw safeError();
  const path = resolve(base, rel); if (!inside(base, path)) throw safeError();
  const parts = rel.split('/'); let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]); const s = await maybeStat(current);
    if (!s) return { path, stat: null };
    if (s.isSymbolicLink() && !(allowLeafLink && i === parts.length - 1)) throw safeError();
    if (i < parts.length - 1 && !s.isDirectory()) throw safeError();
    if (i === parts.length - 1) return { path, stat: s };
  }
}
async function safeJson(base, rel) {
  const { path, stat } = await checkedPath(base, rel);
  if (!stat?.isFile() || stat.size > 65536) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const now = await handle.stat(); if (identity(now) !== identity(stat) || now.size > 65536) throw safeError();
    const text = await handle.readFile('utf8'); if (Buffer.byteLength(text) > 65536) throw safeError();
    const value = JSON.parse(text); return value && !Array.isArray(value) && typeof value === 'object' ? value : null;
  } finally { await handle?.close(); }
}
async function readJob(base, id) {
  if (!JOB_ID.test(id)) return null;
  try { const { stat } = await checkedPath(base, id); if (!stat?.isDirectory()) return null; const job = await safeJson(base, id + '/job.json'); return job?.id === id && KINDS.includes(job.kind) ? job : null; } catch { return null; }
}
function terminal(job) { return !!job && TERMINAL.has(job.status) && job.delivery !== 'pending' && !['playing', 'queued'].includes(job.playback); }
function oldEnough(job, days, now) { const time = Date.parse(job.finishedAt || job.createdAt); return Number.isFinite(time) && time <= now - days * 86400000; }
async function jobsIn(base) {
  const jobs = new Map();
  for (const entry of await readdir(base, { withFileTypes: true })) if (entry.isDirectory() && JOB_ID.test(entry.name)) { const job = await readJob(base, entry.name); if (job) jobs.set(entry.name, job); }
  return jobs;
}
// Symlink targets are never traversed or included in byte totals. A digest binds
// cleanup approval to the observed tree rather than trusting caller-supplied paths.
async function tree(base, rel, visitor) {
  const hash = createHash('sha256'); let bytes = 0, files = 0, links = 0;
  const visit = async (name, depth) => {
    if (depth > 80) throw safeError();
    const { path, stat } = await checkedPath(base, name, true); if (!stat) return;
    hash.update(`${name}\0${identity(stat)}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\n`);
    if (stat.isSymbolicLink()) { links++; if (visitor) await visitor(name, stat, path); return; }
    if (stat.isFile()) { bytes += stat.size; files++; if (visitor) await visitor(name, stat, path); return; }
    if (!stat.isDirectory()) throw safeError();
    for (const entry of (await readdir(path)).sort()) await visit(name + '/' + entry, depth + 1);
  };
  await visit(rel, 0); return { bytes, files, links, digest: hash.digest('hex') };
}
async function externalSize(path) {
  try { const base = await rootInfo(path); let bytes = 0; for (const entry of await readdir(base.path)) bytes += (await tree(base.path, entry)).bytes; return { bytes, readable: true }; } catch { return { bytes: 0, readable: false }; }
}
function optionsSnapshot(options = {}) {
  const externalModels = (options.externalModels ?? []).filter(x => x && typeof x.path === 'string' && isAbsolute(x.path)).map(x => ({ id: typeof x.id === 'string' ? x.id : 'external', label: typeof x.label === 'string' ? x.label : '外部模型', path: resolve(x.path) }));
  const protectedPaths = (options.protectedPaths ?? []).filter(x => typeof x === 'string' && isAbsolute(x)).map(x => resolve(x));
  return { externalModels, protectedPaths };
}
async function protections(base, options) {
  const protectedPaths = [...options.protectedPaths, ...options.externalModels.map(x => x.path)];
  const add = value => { if (typeof value === 'string' && isAbsolute(value)) protectedPaths.push(resolve(value)); };
  // Read only documented runtime pointer fields. Never load or execute configs.
  for (const file of ['engine-v1/paths.json', 'engine-v1/singing-ready.json']) {
    let value; try { value = await safeJson(base, file); } catch { throw new StudioError('运行环境引用无法安全读取，暂不清理。'); }
    if (!value) continue;
    for (const key of ['speechPython', 'asrPython', 'acePython', 'pythonPath', 'ffmpegPath', 'aceRoot']) add(value[key]);
    if (value.mode === 'external') add(value.checkpointRoot);
  }
  for (const rel of RUNTIME_PATHS) {
    const { stat } = await checkedPath(base, rel, true); if (!stat) continue;
    await tree(base, rel, async (name, item, path) => {
      if (item.isSymbolicLink()) {
        const target = resolve(path, '..', await readlink(path)); protectedPaths.push(target);
        try { protectedPaths.push(await realpath(path)); } catch { /* preserve lexical target for broken links */ }
      } else if (item.isFile() && name.endsWith('.pth') && item.size <= 65536) {
        const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
        for (const line of lines) { const value = line.trim(); if (value && !value.startsWith('#') && !value.startsWith('import ')) protectedPaths.push(resolve(path, '..', value)); }
      }
    });
  }
  // Canonical external/runtime references protect aliases without traversing
  // them during accounting or accepting them as cleanup destinations.
  for (const path of [...protectedPaths]) { try { protectedPaths.push(await realpath(path)); } catch {} }
  return [...new Set(protectedPaths)];
}
async function cacheCandidates(base, jobs) { return [...CACHE_PATHS, ...[...jobs].filter(([,job]) => terminal(job)).map(([id]) => `${id}/output/cache`)]; }
function category(rel, jobs) {
  if (MODEL_IDS.some(id => pathMatches(rel, `engine-v1/models/${id}`))) return 'models';
  const id = rel.split('/')[0];
  if (CACHE_PATHS.some(p => pathMatches(rel, p)) || jobs.has(id) && pathMatches(rel, `${id}/output/cache`)) return 'cache';
  if (['reference-library', 'references', 'uploads', 'singing-reference'].some(p => pathMatches(rel, p)) || /^reference-recovery-[^/]+\.json$/.test(rel)) return 'references';
  if (pathMatches(rel, 'diagnostics') || rel.endsWith('.log')) return 'logs';
  if (jobs.has(id)) return 'history';
  if (RUNTIME_PATHS.some(p => pathMatches(rel, p)) || /^engine-v1\/[^/]+\.(json|lock)$/.test(rel)) return 'runtime';
  return 'other';
}
function reasonForProtection(path, protectedPaths) { return protectedPaths.some(p => overlaps(path, p)) ? '该目录仍被运行环境、参考路径或外部模型引用，已保留。' : null; }
async function candidate(base, rel, protectedPaths) {
  const { path, stat } = await checkedPath(base, rel);
  if (!stat) return null;
  const reason = reasonForProtection(path, protectedPaths); if (reason) return { path: rel, blocked: reason };
  const info = await tree(base, rel); return { path: rel, bytes: info.bytes, identity: identity(stat), digest: info.digest };
}

export async function inspectStorage(root, options = {}) {
  const base = await rootInfo(root), opts = optionsSnapshot(options), jobs = await jobsIn(base.path);
  const categories = Object.fromEntries(['models','runtime','cache','history','references','logs','other'].map(id => [id, { bytes: 0, files: 0 }]));
  const warnings = []; let symlinkCount = 0;
  for (const entry of await readdir(base.path)) {
    try { const info = await tree(base.path, entry, (rel, s) => { if (s.isFile()) { const c = categories[category(rel, jobs)]; c.bytes += s.size; c.files++; } }); symlinkCount += info.links; }
    catch { warnings.push('部分文件无法读取，占用统计可能不完整。'); }
  }
  let protectedPaths = [], safeProtections = true;
  try { protectedPaths = await protections(base.path, opts); } catch { safeProtections = false; warnings.push('运行环境引用无法确认，缓存暂不可清理。'); }
  let reclaimableCacheBytes = 0, blockedCacheBytes = 0;
  for (const rel of await cacheCandidates(base.path, jobs)) {
    try {
      const c = safeProtections ? await candidate(base.path, rel, protectedPaths) : null;
      if (c && !c.blocked) reclaimableCacheBytes += c.bytes;
      else if (c?.blocked) blockedCacheBytes += (await tree(base.path, rel)).bytes;
    } catch { warnings.push('符号链接或无法读取的缓存路径已排除清理。'); }
  }
  const models = [];
  for (const id of MODEL_IDS) {
    const rel = `engine-v1/models/${id}`; let bytes = 0, exists = false, deletable = false;
    try { const { stat, path } = await checkedPath(base.path, rel); exists = !!stat; if (stat) bytes = (await tree(base.path, rel)).bytes; deletable = !!stat?.isDirectory() && safeProtections && !reasonForProtection(path, protectedPaths); } catch {}
    // The former CustomVoice directory is retained until an explicit cleanup.
    // Shared Base aliases resolve to `reference`; count that physical tree once.
    if (id !== 'speech' || exists) models.push({ id, label: MODEL_LABELS[id], legacy: id === 'speech', bytes, exists, external: false, deletable });
  }
  const externalModels = [];
  for (const model of opts.externalModels) { const info = await externalSize(model.path); externalModels.push({ id: model.id, label: model.label, ...info, external: true, deletable: false }); }
  const byKind = Object.fromEntries(KINDS.map(kind => [kind, { count: 0, eligibleCount: 0 }]));
  for (const job of jobs.values()) { byKind[job.kind].count++; if (terminal(job)) byKind[job.kind].eligibleCount++; }
  return { logicalBytes: Object.values(categories).reduce((n, c) => n + c.bytes, 0), reclaimableCacheBytes, blockedCacheBytes, categories, models, externalModels, externalModelBytes: externalModels.reduce((n, x) => n + x.bytes, 0), history: { count: jobs.size, eligibleCount: [...jobs.values()].filter(terminal).length, byKind }, symlinkCount, warnings: [...new Set(warnings)], scannedAt: new Date().toISOString(), sizeBasis: 'logical-no-symlinks' };
}
function requestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !['cache','history','models'].includes(request.type)) throw new StudioError('请选择有效的清理类型。');
  const allowed = request.type === 'history' ? ['type','kind','olderThanDays'] : request.type === 'models' ? ['type','models'] : ['type'];
  if (Object.keys(request).some(k => !allowed.includes(k))) throw new StudioError('清理请求不能包含自定义路径或未知字段。');
  if (request.type === 'history') {
    const kind = request.kind ?? 'all', olderThanDays = request.olderThanDays ?? 30;
    if (![...KINDS,'all'].includes(kind) || ![0,7,30].includes(olderThanDays)) throw new StudioError('请选择历史类型及 7 天、30 天或全部。');
    return { type: 'history', kind, olderThanDays };
  }
  if (request.type === 'models') {
    if (!Array.isArray(request.models) || !request.models.length || request.models.some(id => !MODEL_IDS.includes(id))) throw new StudioError('请选择托管模型，不支持外部模型或自定义路径。');
    return { type: 'models', models: [...new Set(request.models)] };
  }
  return { type: 'cache' };
}
export async function planCleanup(root, request, options = {}) {
  const base = await rootInfo(root), wanted = requestShape(request), opts = optionsSnapshot(options), now = Date.now();
  const jobs = await jobsIn(base.path), protectedPaths = await protections(base.path, opts);
  const paths = wanted.type === 'cache' ? await cacheCandidates(base.path, jobs) : wanted.type === 'models' ? wanted.models.map(id => `engine-v1/models/${id}`) : [...jobs].filter(([,j]) => terminal(j) && (wanted.kind === 'all' || j.kind === wanted.kind) && oldEnough(j, wanted.olderThanDays, now)).map(([id]) => id);
  const targets = [], blocked = [];
  for (const rel of paths) { try { const c = await candidate(base.path, rel, protectedPaths); if (c?.blocked) blocked.push({ path: rel, reason: c.blocked }); else if (c) targets.push(c); } catch { blocked.push({ path: rel, reason: '路径为符号链接、已变化或无法安全读取，已保留。' }); } }
  const plan = Object.freeze({ type: wanted.type, bytes: targets.reduce((n, x) => n + x.bytes, 0), jobIds: Object.freeze(wanted.type === 'history' ? targets.map(x => x.path) : []), targets: Object.freeze(targets.map(({path, bytes}) => Object.freeze({path, bytes}))), count: targets.length, jobCount: wanted.type === 'history' ? targets.length : 0, modelIds: Object.freeze(wanted.type === 'models' ? targets.map(x => x.path.split('/').at(-1)) : []), blocked: targets.length === 0 && blocked.length > 0, skipped: Object.freeze(blocked), warnings: blocked.length ? ['部分路径仍被引用或无法安全读取，已排除清理。'] : [], createdAt: new Date(now).toISOString() });
  plans.set(plan, { base, wanted, opts, targets, now }); return plan;
}
async function removeTree(base, rel, counters, expectedRootIdentity) {
  const { path, stat } = await checkedPath(base, rel, true, expectedRootIdentity); if (!stat) return;
  if (stat.isSymbolicLink()) { await unlink(path); return; }
  if (stat.isFile()) { await unlink(path); counters.bytes += stat.size; counters.files++; return; }
  if (!stat.isDirectory()) throw safeError();
  // Preserve job metadata until its payloads have been removed successfully.
  const names = (await readdir(path)).sort((a,b) => a === 'job.json' ? 1 : b === 'job.json' ? -1 : a.localeCompare(b));
  for (const name of names) await removeTree(base, rel + '/' + name, counters, expectedRootIdentity);
  await checkedPath(base, rel, false, expectedRootIdentity);
  await rmdir(path);
}
export async function executeCleanup(root, plan) {
  const stored = plans.get(plan); if (!stored) throw new StudioError('清理预览已失效，请重新预览并确认。'); plans.delete(plan);
  const base = await rootInfo(root); if (base.path !== stored.base.path || base.identity !== stored.base.identity) throw safeError();
  const result = { removedBytes: 0, removedCount: 0, removedFiles: 0, removedJobIds: [], removedModelIds: [], failed: [], skipped: [] };
  // The caller holds its maintenance lock across execution. Resolve runtime
  // dependencies once before any mutation; each deletion still checks its root
  // identity and parent chain, and each target must match the approved digest.
  const protectedPaths = await protections(base.path, stored.opts);
  for (const target of stored.targets) {
    const counters = { bytes: 0, files: 0 };
    try {
      const fresh = await rootInfo(root); if (fresh.path !== base.path || fresh.identity !== base.identity) throw safeError();
      const current = await candidate(base.path, target.path, protectedPaths);
      if (!current || current.blocked || current.identity !== target.identity || current.digest !== target.digest) { result.skipped.push({ path: target.path, reason: current?.blocked ?? '文件已变化，请重新预览。' }); continue; }
      const id = target.path.split('/')[0];
      if (JOB_ID.test(id)) {
        const job = await readJob(base.path, id);
        if (!terminal(job) || stored.wanted.type === 'history' && ((stored.wanted.kind !== 'all' && job.kind !== stored.wanted.kind) || !oldEnough(job, stored.wanted.olderThanDays, stored.now))) { result.skipped.push({ path: target.path, reason: '任务状态已变化，已保留。' }); continue; }
      }
      await removeTree(base.path, target.path, counters, base.identity); result.removedCount++;
      if (stored.wanted.type === 'history') result.removedJobIds.push(target.path);
      if (stored.wanted.type === 'models') result.removedModelIds.push(target.path.split('/').at(-1));
    } catch { result.failed.push({ path: target.path, reason: '文件无法移除，可能权限不足或路径已变化；其他清理结果已保留。' }); }
    finally { result.removedBytes += counters.bytes; result.removedFiles += counters.files; }
  }
  return result;
}
