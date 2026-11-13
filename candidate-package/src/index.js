import { DEFAULTS, ID, LABEL, TOOLS } from './config.js';
import { VoiceStudioWorld } from './world.js';
export { VoiceStudioWorld };
export const voiceStudioDefinition = {
  id: ID, label: LABEL, defaults: () => structuredClone(DEFAULTS),
  create: (ctx) => new VoiceStudioWorld(ctx),
  describe: {
    tools: TOOLS.map((tool) => ({ ...tool, summary: { zh: tool.description.split('。')[0] + '。', en: ({ voice_studio_transcribe: 'Transcribe a received QQ voice message locally.', voice_studio_speak: 'Generate local speech.', voice_studio_sing: 'Create a local original song.', voice_studio_status: 'Inspect studio jobs.', voice_studio_play: 'Play a studio recording.', voice_studio_stop: 'Stop studio generation and playback.' })[tool.name] } })),
    events: [
      { type: 'voice-studio.transcript', description: { zh: 'QQ 语音的本地识别结果，保留原消息编号、发送者和会话；结合原始消息回复一次。', en: 'Local QQ voice transcription with the original message and conversation identity.' }, trigger: 'debounce' },
      { type: 'voice-studio.ready', description: { zh: '语音或歌曲完成，附音频；若请求播放，插件已排播放，不要重复播放。', en: 'Audio is ready; requested playback is already handled by the studio.' }, trigger: 'debounce' },
      { type: 'voice-studio.failed', description: { zh: '生成失败，附任务号与简短原因。', en: 'Generation failed with a short diagnostic.' }, trigger: 'debounce' },
      { type: 'voice-studio.playback-failed', description: { zh: '本机播放失败，作品仍已保存。', en: 'Local playback failed; the recording remains saved.' }, trigger: 'debounce' },
    ],
  },
};
export default voiceStudioDefinition;
