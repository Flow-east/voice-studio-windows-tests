import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DEFAULTS, StudioError, settings, singingPreferences } from './config.js';
import { sniffAudio } from './files.js';

const FIELDS = new Set(['backend','companionUrl','referenceAudioPath','referenceText','referenceName','singingEnabled','singingVoice','singingStyle','singingDescription','singingUseReference','language','volume','timeoutMs','maxQueue']);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function installerSnapshot(cfg) {
  const normalized = settings(cfg);
  // Secrets live in the host's secret store; only its variable name is config.
  return { config: Object.fromEntries(Object.keys(DEFAULTS).filter(key => key !== 'enabled').map(key => [key, normalized[key]])) };
}
export async function installerPatch(value, cfg) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.has(key))) throw new StudioError('安装配置包含不支持的字段。');
  const patch = { backend: 'managed', ...value };
  if (patch.backend !== 'managed') throw new StudioError('新版安装器仅支持插件内置的本地引擎。');
  if (has(value,'companionUrl')) {
    let url; try { url = new URL(value.companionUrl); } catch { throw new StudioError('Coopanion 地址无效。'); }
    if (typeof value.companionUrl !== 'string' || !['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new StudioError('Coopanion 地址必须是本机根地址。');
    patch.companionUrl = url.origin;
  }
  for (const [key,min,max] of [['volume',0,100],['timeoutMs',1000,600000],['maxQueue',1,3]]) if (has(value,key) && (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)) throw new StudioError('安装配置中的数值超出范围。');
  if (has(value,'singingEnabled') && typeof value.singingEnabled !== 'boolean') throw new StudioError('唱歌开关必须是开启或关闭。');
  singingPreferences({voice: value.singingVoice, style: value.singingStyle, description: value.singingDescription, useReference: value.singingUseReference},settings(cfg));
  if (has(value,'language') && value.language !== 'chinese') throw new StudioError('当前版本的默认说话语言为 chinese。');
  if (has(value,'referenceName') && (typeof value.referenceName !== 'string' || value.referenceName.length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(value.referenceName))) throw new StudioError('参考音频名称无效。');
  if (has(value,'referenceAudioPath') !== has(value,'referenceText')) throw new StudioError('参考音频与逐字稿必须一起迁移。');
  if (has(value,'referenceAudioPath')) {
    if (typeof value.referenceAudioPath !== 'string' || typeof value.referenceText !== 'string' || value.referenceAudioPath.length > 4096 || value.referenceText.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.referenceText) || /[\u0000-\u001f\u007f]/u.test(value.referenceAudioPath)) throw new StudioError('参考音频配置无效。');
    const audio = value.referenceAudioPath.trim(), text = value.referenceText.trim();
    if (!!audio !== !!text) throw new StudioError('参考音频与逐字稿必须同时有效，原配置已保留。');
    if (audio) {
      if (!isAbsolute(audio)) throw new StudioError('参考音频需要使用本机绝对路径。');
      let file;
      try {
        file = await open(audio,constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
        const stat = await file.stat(), bytes = Buffer.alloc(12);
        if (!stat.isFile() || stat.size < 44 || stat.size > 15*1024*1024) throw new Error('Invalid reference size');
        await file.read(bytes,0,bytes.length,0);
        if (sniffAudio(bytes) !== 'audio/wav') throw new Error('Invalid reference signature');
      } catch { throw new StudioError('参考 WAV 无法读取或格式无效，原配置已保留。'); }
      finally { await file?.close().catch(() => {}); }
    }
    patch.referenceAudioPath = audio; patch.referenceText = text;
    if (!audio) patch.referenceName = '';
  }
  return patch;
}
