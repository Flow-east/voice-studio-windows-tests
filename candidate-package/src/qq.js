// Fixed, read-only Coopanion metadata + QQ gate snapshot. Never request credentials or send tools.
const PACKAGE = 'cortico-world-qq';
const WORLD = 'qq';
export function qqUnknown(detail = '尚未检测 QQ 插件。') {
  return { status: 'unknown', installed: null, enabled: null, connected: null, version: null, detail, checkedAt: null };
}
function localOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid local root');
  return url.origin;
}
async function readJson(fetchImpl, base, path, post = false) {
  const response = await fetchImpl(base + path, { method: post ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(4000), ...(post ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: [] }) } : {}) });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('Metadata unavailable'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response');
  const chunks = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('Oversized metadata'); chunks.push(Buffer.from(value)); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function detectQQ(companionUrl = 'http://127.0.0.1:17788', { fetchImpl = fetch } = {}) {
  let base; try { base = localOrigin(companionUrl); } catch { return { ...qqUnknown('Coopanion 检测地址必须是本机根地址。'), checkedAt: new Date().toISOString() }; }
  const result = { ...qqUnknown(), checkedAt: new Date().toISOString() };
  try {
    const [packages, worlds] = await Promise.all([readJson(fetchImpl, base, '/api/extensions'), readJson(fetchImpl, base, '/api/worlds')]);
    if (!Array.isArray(packages.extensions) || !Array.isArray(worlds.worlds)) throw new Error('Unknown response format');
    const pkg = packages.extensions.find((p) => p.name === PACKAGE);
    const world = worlds.worlds.find((w) => w.id === WORLD);
    result.installed = !!pkg || !!world;
    result.version = typeof pkg?.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(pkg.version) ? pkg.version : null;
    if (!result.installed) return { ...result, status: 'missing', enabled: false, connected: false, detail: '未安装 QQ 插件，请先在 Coopanion 插件市场安装 QQ。' };
    if (!world || ['inactive', 'disabled', 'missing'].includes(world.status)) return { ...result, status: 'disabled', enabled: false, connected: false, detail: 'QQ 插件已安装，尚未启用；请到 QQ 插件中开启接入。' };
    // QQ 0.2.7 does not declare state as a GET method; POST invokes only its read-only gate.state.
    // This snapshot also includes identity and roster data; retain exactly these two booleans.
    const gate = await readJson(fetchImpl, base, '/api/webui/providers/world%3Aqq/panels/gate/state', true);
    if (typeof gate.enabled !== 'boolean' || typeof gate.connected !== 'boolean') throw new Error('Unknown gate format');
    result.enabled = gate.enabled; result.connected = gate.enabled && gate.connected;
    if (!result.enabled) return { ...result, status: 'disabled', detail: 'QQ 接入未启用，请到 QQ 插件中开启。' };
    return result.connected
      ? { ...result, status: 'connected', detail: 'QQ 插件已连接；可通过 QQ 插件发送生成的语音。' }
      : { ...result, status: 'disconnected', detail: 'QQ 插件已启用但未连接，请检查 QQ 登录和 OneBot 协议端。' };
  } catch { return { ...result, status: 'unknown', detail: '暂时无法确认 QQ 连接状态，请确认 Coopanion 已启动或在 QQ 插件中检查。' }; }
}
