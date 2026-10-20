import type { VoiceTranscriptionProvider } from '@/types/api'

export interface VoiceOption {
  value: string
  label: string
  detail: string
  recommended?: boolean
}

export interface VoiceProviderOption extends VoiceOption {
  value: VoiceTranscriptionProvider
  credential?: 'openai' | 'groq' | 'deepgram'
}

export const VOICE_PROVIDER_OPTIONS: VoiceProviderOption[] = [
  { value: 'openai-live', label: 'OpenAI · Live', detail: '边说边出文字。', credential: 'openai', recommended: true },
  { value: 'openai', label: 'OpenAI · Recorded', detail: '先录音，再整段转写。', credential: 'openai' },
  { value: 'groq', label: 'Groq', detail: '用 Whisper 快速转写录音。', credential: 'groq' },
  { value: 'deepgram', label: 'Deepgram', detail: '用 Nova 语音模型转写录音。', credential: 'deepgram' },
  { value: 'self-hosted', label: 'Self-hosted · Parakeet / Whisper', detail: '连接你自己的 OpenAI 兼容转写服务。' },
  { value: 'local-whisper', label: 'Local · whisper.cpp', detail: '完全在本机运行，使用你自己的模型文件。' },
]

export const OPENAI_LIVE_MODELS: VoiceOption[] = [
  { value: 'gpt-live-transcribe', label: 'GPT Live Transcribe', detail: '延迟最低的实时听写。', recommended: true },
  { value: 'gpt-realtime-whisper', label: 'GPT Realtime Whisper', detail: '流式转写，可调节延迟和准确度。' },
]

export const OPENAI_FILE_MODELS: VoiceOption[] = [
  { value: 'gpt-transcribe', label: 'GPT Transcribe', detail: '当前的高准确度转写模型。', recommended: true },
  { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', detail: '准确的多语言转写。' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', detail: '成本更低的 GPT-4o 转写。' },
  { value: 'whisper-1', label: 'Whisper', detail: '旧版通用语音识别。' },
]

export const GROQ_MODELS: VoiceOption[] = [
  { value: 'whisper-large-v3-turbo', label: 'Whisper Large V3 Turbo', detail: '多语言听写中性价比和速度最好。', recommended: true },
  { value: 'whisper-large-v3', label: 'Whisper Large V3', detail: '准确度更高，适合不容出错的转写。' },
]

export const DEEPGRAM_MODELS: VoiceOption[] = [
  { value: 'nova-3', label: 'Nova-3 General', detail: '通用场景准确度最好。', recommended: true },
  { value: 'nova-3-medical', label: 'Nova-3 Medical', detail: '医学词汇和临床音频。' },
  { value: 'nova-2-meeting', label: 'Nova-2 Meeting', detail: '会议室和多人发言。' },
  { value: 'nova-2-phonecall', label: 'Nova-2 Phone Call', detail: '低带宽电话音频。' },
  { value: 'nova-2-conversationalai', label: 'Nova-2 Conversational AI', detail: '语音助手和自动对话。' },
]

export const REALTIME_MODELS: VoiceOption[] = [
  { value: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', detail: '语音协调和工具调用效果最好。', recommended: true },
  { value: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini', detail: '成本更低的实时语音协调。' },
]

export const REALTIME_VOICES: VoiceOption[] = [
  { value: 'marin', label: 'Marin', detail: '自然，像聊天。', recommended: true },
  { value: 'cedar', label: 'Cedar', detail: '温暖沉稳。', recommended: true },
  { value: 'alloy', label: 'Alloy', detail: '均衡中性。' },
  { value: 'ash', label: 'Ash', detail: '清晰直接。' },
  { value: 'ballad', label: 'Ballad', detail: '富有表现力且有分寸。' },
  { value: 'coral', label: 'Coral', detail: '明亮友好。' },
  { value: 'echo', label: 'Echo', detail: '平稳顺滑。' },
  { value: 'sage', label: 'Sage', detail: '冷静从容。' },
  { value: 'shimmer', label: 'Shimmer', detail: '轻快有活力。' },
  { value: 'verse', label: 'Verse', detail: '生动流畅。' },
]

export function optionsWithCurrent(options: VoiceOption[], current: string): VoiceOption[] {
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: `${current}（之前的设置）`, detail: '沿用之前的配置。' }, ...options]
}
