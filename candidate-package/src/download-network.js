import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { privateProcessEnvironment, windowsSystemExecutable } from './process.js';

const SCHEMES = ['http', 'https', 'all'];
const MAX_VALUE = 32768;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

function effectiveValue(parentEnv, name) {
  const lower = name.toLowerCase(), upper = name.toUpperCase();
  return own(parentEnv, lower) ? parentEnv[lower] : parentEnv[upper];
}

function pair(target, name, value) {
  target[name.toLowerCase()] = value;
  target[name.toUpperCase()] = value;
}

function safeEnvironmentValue(value) {
  return typeof value === 'string' && value.length <= MAX_VALUE && !value.includes('\0');
}

function validHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s/@?#\\%]/.test(value)) return null;
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unbracketed)) return isIP(unbracketed) === 6 ? `[${unbracketed}]` : unbracketed;
  const host = domainToASCII(value);
  if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) return null;
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.some(label => !label || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) return null;
  return host;
}

function validEnvironmentProxy(value) {
  if (!safeEnvironmentValue(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  if (value === '') return true;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return PROTOCOLS.has(url.protocol) && !!validHost(url.hostname)
      && (!url.port || Number(url.port) >= 1 && Number(url.port) <= 65535)
      && (!url.pathname || url.pathname === '/') && !url.search && !url.hash;
  } catch { return false; }
}

function readMacSystemProxy() {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) reject(new Error('SYSTEM_PROXY_UNAVAILABLE'));
      else resolve(stdout);
    });
  });
}

// Read only the current user's WinINET manual settings. PAC URLs are reduced to
// a boolean in the reader and are never fetched, executed, logged or returned.
// Format references: Microsoft WinINET "Enabling Internet Functionality" and
// WINHTTP_PROXY_INFO describe per-protocol servers and semicolon bypass lists.
const WINDOWS_PROXY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$p = Get-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
[ordered]@{
  ProxyEnable = $(if ($p -and $p.ProxyEnable -eq 1) { 1 } else { 0 })
  ProxyServer = [string]$p.ProxyServer
  ProxyOverride = [string]$p.ProxyOverride
  HasAutoConfig = [bool]([string]$p.AutoConfigURL)
  AutoDetect = [bool]($p.AutoDetect -eq 1)
} | ConvertTo-Json -Compress
`;
export function readWindowsSystemProxy({ execute = execFile, parentEnv = process.env } = {}) {
  return new Promise((resolve, reject) => {
    try {
      execute(windowsSystemExecutable('powershell', parentEnv), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PROXY_SCRIPT, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true, shell: false, env: privateProcessEnvironment(parentEnv) }, (error, stdout) => {
        if (error) reject(new Error('SYSTEM_PROXY_UNAVAILABLE'));
        else resolve(stdout);
      });
    } catch { reject(new Error('SYSTEM_PROXY_UNAVAILABLE')); }
  });
}

function parseWindowsOutput(output) {
  if (typeof output !== 'string' || output.length > 65536) return null;
  let value; try { value = JSON.parse(output.replace(/^\uFEFF/, '')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![0, 1].includes(value.ProxyEnable)) return null;
  if (!['ProxyServer', 'ProxyOverride'].every(key => typeof value[key] === 'string' && safeEnvironmentValue(value[key])) || !['HasAutoConfig', 'AutoDetect'].every(key => typeof value[key] === 'boolean')) return null;
  return value;
}

function windowsProxyURL(value) {
  if (!safeEnvironmentValue(value) || !value || /[\s\u0000-\u001f\u007f]/.test(value) || value.endsWith(':')) return null;
  try {
    const url = new URL(value.includes('://') ? value : 'http://' + value), host = validHost(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) || !host || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) return null;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return port >= 1 && port <= 65535 ? `${url.protocol}//${host}:${port}` : null;
  } catch { return null; }
}

function applyWindowsProxy(system, proxyEnv, warnings, hasBypass) {
  if (system.HasAutoConfig || system.AutoDetect) warnings.push('SYSTEM_PAC_UNSUPPORTED');
  if (system.ProxyEnable !== 1) return false;
  const entries = system.ProxyServer.trim().split(/[;\s]+/).filter(Boolean), servers = new Map();
  for (const entry of entries) {
    const match = /^([A-Za-z]+)=(.+)$/.exec(entry), key = match ? match[1].toLowerCase() : 'default', value = match ? match[2] : entry;
    if (servers.has(key) || !['default', 'http', 'https', 'socks', 'ftp'].includes(key)) { warnings.push('INVALID_SYSTEM_PROXY'); return false; }
    servers.set(key, value);
  }
  if (servers.has('socks')) warnings.push('SYSTEM_SOCKS_UNSUPPORTED');
  let applied = false;
  for (const scheme of ['http', 'https']) {
    const raw = servers.get(scheme) ?? servers.get('default'); if (raw === undefined) continue;
    const proxy = windowsProxyURL(raw);
    if (!proxy) { warnings.push('INVALID_SYSTEM_PROXY'); continue; }
    pair(proxyEnv, scheme + '_proxy', proxy); applied = true;
  }
  if (!entries.length || !applied && !servers.has('socks')) warnings.push('INVALID_SYSTEM_PROXY');
  if (!hasBypass && applied && system.ProxyOverride.trim()) {
    const rules = system.ProxyOverride.trim().split(/[;\s]+/).filter(Boolean), bypass = rules.map(systemBypass).filter(value => value !== null);
    if (bypass.length) pair(proxyEnv, 'no_proxy', [...new Set(bypass)].join(','));
    // NO_PROXY cannot represent WinINET's <local> (all single-label hosts), nor
    // arbitrary wildcard patterns. Never broaden an unsupported bypass to '*'.
    if (rules.length !== bypass.length) warnings.push('SYSTEM_BYPASS_PARTIAL');
  }
  return applied;
}

function parseSystemOutput(output) {
  if (typeof output !== 'string' || output.length > 65536) return null;
  const fields = {}, exceptions = [], stack = [];
  let sawRoot = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '<dictionary> {' && !sawRoot) { sawRoot = true; stack.push('root'); continue; }
    if (line === '}') { if (!stack.length) return null; stack.pop(); continue; }
    const nested = /^([A-Za-z0-9_]+)\s*:\s*<(array|dictionary)>\s*\{$/.exec(line);
    if (nested && stack.length) { stack.push(nested[1]); continue; }
    const field = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (stack.length === 1 && field) {
      if (own(fields, field[1])) return null;
      fields[field[1]] = field[2]; continue;
    }
    const entry = /^\d+\s*:\s*(.*)$/.exec(line);
    if (stack.length === 2 && stack[1] === 'ExceptionsList' && entry) { exceptions.push(entry[1]); continue; }
    // Unknown nested dictionaries are ignored; malformed root data is not used.
    if (stack.length <= 1) return null;
  }
  return sawRoot && stack.length === 0 ? { fields, exceptions } : null;
}

function systemBypass(value) {
  if (value === '*') return value;
  if (!safeEnvironmentValue(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.includes('/')) {
    const match = /^(.+)\/(\d{1,3})$/.exec(value), version = match ? isIP(match[1]) : 0;
    return version && Number(match[2]) <= (version === 4 ? 32 : 128) ? value : null;
  }
  if (value.startsWith('*.')) return validHost(value.slice(2)) ? '.' + value.slice(2) : null;
  if (value.startsWith('.')) return validHost(value.slice(1)) ? value : null;
  return validHost(value) ? value : null;
}

/**
 * Resolve proxy settings for one download command; no global state is changed.
 * `proxyEnv` is private spawn input and may contain operator-supplied credentials.
 * Never serialize it into logs, diagnostics or the UI. Only `source` and fixed
 * warning codes are suitable for public status. The reader is injectable so tests
 * never inspect or change the user's network settings.
 */
export async function resolveDownloadNetwork({ parentEnv = process.env, platform = process.platform, readSystemProxy } = {}) {
  const proxyEnv = {}, warnings = [];
  if (platform === 'win32') {
    const normalized = { ...parentEnv };
    for (const [key, value] of Object.entries(parentEnv)) if (/^(?:https?|all|no)_proxy$/i.test(key) && !own(parentEnv, key.toLowerCase()) && !own(parentEnv, key.toUpperCase())) normalized[key.toUpperCase()] = value;
    parentEnv = normalized;
  }
  const hasBypass = own(parentEnv, 'no_proxy') || own(parentEnv, 'NO_PROXY');
  if (hasBypass) {
    const value = effectiveValue(parentEnv, 'no_proxy');
    if (safeEnvironmentValue(value)) pair(proxyEnv, 'no_proxy', value);
    else { pair(proxyEnv, 'no_proxy', ''); warnings.push('INVALID_NO_PROXY_ENV'); }
  }
  const hasProxy = SCHEMES.some(scheme => own(parentEnv, scheme + '_proxy') || own(parentEnv, scheme.toUpperCase() + '_PROXY'));
  if (hasProxy) {
    for (const scheme of SCHEMES) {
      if (!own(parentEnv, scheme + '_proxy') && !own(parentEnv, scheme.toUpperCase() + '_PROXY')) continue;
      const value = effectiveValue(parentEnv, scheme + '_proxy');
      if (validEnvironmentProxy(value)) pair(proxyEnv, scheme + '_proxy', value);
      else { pair(proxyEnv, scheme + '_proxy', ''); warnings.push('INVALID_PROXY_ENV'); }
    }
    return { proxyEnv, source: 'environment', warnings: [...new Set(warnings)] };
  }
  if (platform === 'win32') {
    let system;
    try { system = parseWindowsOutput(await (readSystemProxy ?? (() => readWindowsSystemProxy({ parentEnv })))()); } catch { /* Private values never leave the reader. */ }
    if (!system) return { proxyEnv, source: 'direct', warnings: [...warnings, 'SYSTEM_PROXY_UNAVAILABLE'] };
    const applied = applyWindowsProxy(system, proxyEnv, warnings, hasBypass);
    return { proxyEnv, source: applied ? 'system' : 'direct', warnings: [...new Set(warnings)] };
  }
  if (platform !== 'darwin') return { proxyEnv, source: 'direct', warnings };

  let system;
  try { system = parseSystemOutput(await (readSystemProxy ?? readMacSystemProxy)()); } catch { /* Never propagate raw command output or errors. */ }
  if (!system) return { proxyEnv, source: 'direct', warnings: [...warnings, 'SYSTEM_PROXY_UNAVAILABLE'] };
  const { fields, exceptions } = system;
  let applied = false;
  for (const [key, scheme] of [['HTTP', 'http'], ['HTTPS', 'https']]) {
    if (fields[key + 'Enable'] !== '1') continue;
    const host = validHost(fields[key + 'Proxy']), port = fields[key + 'Port'];
    if (!host || !/^\d{1,5}$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) { warnings.push('INVALID_SYSTEM_PROXY'); continue; }
    // HTTPSProxy is an HTTP CONNECT proxy for HTTPS destinations; it does not
    // imply that the connection to the proxy server itself uses TLS.
    pair(proxyEnv, scheme + '_proxy', `http://${host}:${Number(port)}`); applied = true;
  }
  if (fields.ProxyAutoConfigEnable === '1' || fields.ProxyAutoDiscoveryEnable === '1') warnings.push('SYSTEM_PAC_UNSUPPORTED');
  if (fields.SOCKSEnable === '1') warnings.push('SYSTEM_SOCKS_UNSUPPORTED');
  if (!hasBypass && applied) {
    const bypass = exceptions.map(systemBypass).filter(value => value !== null);
    if (bypass.length) pair(proxyEnv, 'no_proxy', [...new Set(bypass)].join(','));
    if (bypass.length !== exceptions.length || fields.ExcludeSimpleHostnames === '1') warnings.push('SYSTEM_BYPASS_PARTIAL');
  }
  return { proxyEnv, source: applied ? 'system' : 'direct', warnings: [...new Set(warnings)] };
}
