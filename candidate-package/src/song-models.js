import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
export const SONG_COMPONENTS = ['acestep-v15-turbo', 'acestep-5Hz-lm-1.7B', 'Qwen3-Embedding-0.6B', 'vae'];
const file = p => { try { const s = statSync(p); return s.isFile() && s.size > 0; } catch { return false; } };
// Presence check only: match the runtime's required components and referenced weight shards.
// Does not load GPU models, fetch weights, or promise the checkpoint can execute.
export function inspectSongModels(root) {
  const missing = [];
  if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, missing: [...SONG_COMPONENTS] };
  for (const component of SONG_COMPONENTS) {
    const dir = join(root, component); let weights = false, complete = true, visited = 0;
    try {
      if (!file(join(dir, 'config.json'))) throw new Error('Missing config');
      const walk = (folder, depth = 0) => {
        if (depth > 8) throw new Error('Too deep');
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          if (++visited > 10000) throw new Error('Too many files');
          if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
          const path = join(folder, entry.name);
          if (entry.isDirectory()) { walk(path, depth + 1); continue; }
          if (/\.(safetensors|bin)$/.test(entry.name) && file(path)) weights = true;
          if (/\.(safetensors|bin)\.index\.json$/.test(entry.name)) {
            if (statSync(path).size > 1024 * 1024) throw new Error('Oversized index');
            const index = JSON.parse(readFileSync(path, 'utf8'));
            if (!index.weight_map || typeof index.weight_map !== 'object') throw new Error('Missing weight map');
            for (const shard of new Set(Object.values(index.weight_map))) {
              if (typeof shard !== 'string') throw new Error('Invalid shard');
              const target = resolve(folder, shard), rel = relative(dir, target);
              if (rel.startsWith('..') || isAbsolute(rel) || !file(target)) complete = false;
            }
          }
        }
      };
      walk(dir);
      if (!weights || !complete) missing.push(component);
    } catch { missing.push(component); }
  }
  return { ok: missing.length === 0, missing };
}
