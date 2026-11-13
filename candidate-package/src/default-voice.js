import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioError } from './config.js';

const ASSET_ROOT = fileURLToPath(new URL('../assets/default-voice/', import.meta.url));
const failure = () => new StudioError('内置默认音色文件不完整，请更新或重新安装插件。');

// This selected default sample is packaged separately from the user's library.
// Selecting default never copies it into or replaces any personal voice slot.
export function defaultVoiceReference(root = ASSET_ROOT) {
  try {
    const metadataPath = join(root, 'metadata.json'), audio = join(root, 'reference.wav');
    const metaStat = lstatSync(metadataPath), audioStat = lstatSync(audio);
    if (!metaStat.isFile() || metaStat.size > 16384 || !audioStat.isFile() || audioStat.size < 44 || audioStat.size > 1024 * 1024) throw failure();
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (metadata.schema !== 1 || metadata.audio !== 'reference.wav' || metadata.source?.type !== 'user-selected-video' || metadata.source?.clip !== 'blue-character'
      || !/^[a-f0-9]{64}$/.test(metadata.source?.sourceSha256 ?? '')
      || metadata.source?.startSeconds !== 6.95 || metadata.source?.endSeconds !== 10
      || metadata.sampleRate !== 24000 || metadata.channels !== 1
      || !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds < 3 || metadata.durationSeconds > 20
      || typeof metadata.text !== 'string' || !metadata.text.trim() || metadata.text.length > 1000
      || /[\u0000-\u001f\u007f]/u.test(metadata.text) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw failure();
    const bytes = readFileSync(audio);
    if (bytes.length !== audioStat.size || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
      || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw failure();
    return { audio, text: metadata.text, bytes, durationSeconds: metadata.durationSeconds };
  } catch { throw failure(); }
}
