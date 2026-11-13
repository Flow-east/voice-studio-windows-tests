import { readFileSync } from 'node:fs';

// Decimal bytes of the pinned files selected by prepare_models.py, including
// tokenizer/decoder files. Recalculate these when pinned model revisions change.
// Running environments, package caches and user audio are separate from models.
const SONG_COMPONENTS = [
  { name: 'acestep-v15-turbo', label: '歌曲生成', description: '生成演唱、旋律和伴奏的声音细节。', modelBytes: 4791777953 },
  { name: 'acestep-5Hz-lm-1.7B', label: '音乐规划', description: '规划旋律、节奏和编曲，为歌曲生成提供引导。', modelBytes: 3755412617 },
  { name: 'Qwen3-Embedding-0.6B', label: '文字理解', description: '将歌词和风格描述转换成音乐模型可用的信息。', modelBytes: 1207471006 },
  { name: 'vae', label: '音频解码', description: '将模型生成的结果还原成可播放的声音。', modelBytes: 337431813 },
];
const MODELS = [
  { id: 'speech', area: 'speech', label: '语音合成', name: 'Qwen3-TTS-12Hz-1.7B-Base-8bit', description: '默认音色与上传的参考音色共用。', modelBytes: 3104156243, optional: false },
  { id: 'transcription', area: 'speech', label: 'QQ 语音识别', name: 'Qwen3-ASR-0.6B-8bit', modelBytes: 1010771234, optional: false },
  { id: 'singing', area: 'singing', label: '原创唱歌', name: 'ACE-Step 1.5', modelBytes: SONG_COMPONENTS.reduce((sum, part) => sum + part.modelBytes, 0), optional: true, components: SONG_COMPONENTS },
];
function modelsFor(device) {
  if (device?.speechBackend !== 'torch') return MODELS;
  const manifest = JSON.parse(readFileSync(new URL('../runtime/model-files-torch.json', import.meta.url), 'utf8'));
  return MODELS.map(model => model.id === 'singing' ? model : { ...model,
    name: manifest.models[model.id === 'speech' ? 'reference' : 'asr'].repo.split('/').at(-1),
    modelBytes: manifest.models[model.id === 'speech' ? 'reference' : 'asr'].totalBytes });
}
export function modelCatalog(engine = {}, device) {
  return modelsFor(device).map(model => ({ ...(engine[model.id] ?? { state: 'missing', stage: '尚未下载' }), ...model, ...(model.components ? { components: model.components.map(part => ({ ...part })) } : {}) }));
}

export function storageSummary(device) {
  const bytes = Object.fromEntries(modelsFor(device).map(model => [model.id, model.modelBytes]));
  const basic = bytes.speech + bytes.transcription;
  // Windows may prepare CUDA dependencies for three isolated environments.
  // Budget for copied wheels too; hardlink sharing depends on the filesystem.
  const native = device?.speechBackend === 'torch', windows = device?.platform === 'win32';
  const basicFree = windows ? 30e9 : native ? 20e9 : 10e9, allFree = windows ? 50e9 : native ? 35e9 : 25e9;
  const gb = n => (n / 1e9).toFixed(1);
  return {
    unit: 'GB', bytesPerGB: 1e9,
    profiles: {
      basic: { modelBytes: basic, recommendedFreeBytes: basicFree },
      reference: { modelBytes: basic, recommendedFreeBytes: basicFree },
      singing: { modelBytes: basic + bytes.singing, recommendedFreeBytes: allFree },
      all: { modelBytes: basic + bytes.singing, recommendedFreeBytes: allFree },
    },
    speech: { note: `语音合成与 QQ 语音识别模型共约 ${gb(basic)} GB，首次安装建议预留 ${basicFree / 1e9} GB。默认音色和上传的参考音色共用模型，无需额外下载。预留空间含运行组件和下载缓存，录音与生成作品另计。` },
    singing: { note: `唱歌模型共约 ${gb(bytes.singing)} GB。语音 + 唱歌模型共约 ${gb(basic + bytes.singing)} GB，首次安装建议预留 ${allFree / 1e9} GB；添加参考音色不增加模型下载量。预留空间含运行组件和下载缓存，生成作品另计。` },
  };
}
