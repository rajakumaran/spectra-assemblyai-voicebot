/**
 * AssemblyAI Voicebot Standalone Types & Models
 * Designed for self-contained export to showcase to sponsors (AssemblyAI / Lablab.ai).
 */

export type VoicebotStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';
export type SpeechEngineType = 'device' | 'assemblyai' | 'assemblyai-sync';

/**
 * One of Universal-3.5 Pro's 18 natively supported languages. The model code-switches between them
 * without being told, so these codes only *narrow* the search when the user knows what they'll speak.
 */
export interface VoiceLanguage {
  /** ISO 639-1, the form AssemblyAI expects in `language_codes`. */
  code: string;
  /** BCP-47 tag for the browser Web Speech API, which needs a region to pick a recogniser. */
  webSpeechTag: string;
  label: string;
}

export const VOICE_LANGUAGES: VoiceLanguage[] = [
  { code: 'en', webSpeechTag: 'en-US', label: 'English' },
  { code: 'hi', webSpeechTag: 'hi-IN', label: 'Hindi' },
  { code: 'es', webSpeechTag: 'es-ES', label: 'Spanish' },
  // { code: 'fr', webSpeechTag: 'fr-FR', label: 'French' },
  { code: 'de', webSpeechTag: 'de-DE', label: 'German' },
  { code: 'it', webSpeechTag: 'it-IT', label: 'Italian' },
  // { code: 'pt', webSpeechTag: 'pt-BR', label: 'Portuguese' },
  // { code: 'nl', webSpeechTag: 'nl-NL', label: 'Dutch' },
  // { code: 'tr', webSpeechTag: 'tr-TR', label: 'Turkish' },
  // { code: 'sv', webSpeechTag: 'sv-SE', label: 'Swedish' },
  // { code: 'no', webSpeechTag: 'nb-NO', label: 'Norwegian' },
  // { code: 'da', webSpeechTag: 'da-DK', label: 'Danish' },
  // { code: 'fi', webSpeechTag: 'fi-FI', label: 'Finnish' },
  // { code: 'vi', webSpeechTag: 'vi-VN', label: 'Vietnamese' },
  // { code: 'ar', webSpeechTag: 'ar-SA', label: 'Arabic' },
  // { code: 'he', webSpeechTag: 'he-IL', label: 'Hebrew' },
  { code: 'ja', webSpeechTag: 'ja-JP', label: 'Japanese' },
  { code: 'zh', webSpeechTag: 'zh-CN', label: 'Chinese' },
];

/** Sync STT response: `{ text, words, confidence, audio_duration_ms, session_id, request_time_ms }`. */
export interface SyncTranscriptResult {
  text?: string;
  confidence?: number;
  audio_duration_ms?: number;
  language_code?: string;
  /** RFC 9457 problem-details on failure, e.g. 'audio_too_short', 'capacity_exceeded'. */
  error_code?: string;
  detail?: string;
}

export interface VoicebotCommand {
  action: 'NEXT_TRACK' | 'PREV_TRACK' | 'PLAY' | 'PAUSE' | 'THEME_CHANGE' | 'VOLUME_CHANGE' | 'AI_CHAT' | 'UNKNOWN';
  rawText: string;
  confidence?: number;
  params?: {
    themeName?: string;
    volumeDelta?: number;
    chatReply?: string;
    [key: string]: any;
  };
}

/** A host-app command matched from speech. run() executes it and returns the reply to show. */
export interface VoicebotAppCommand {
  label: string;
  run: () => string;
}

/** Optional host hook, tried before the built-in keyword commands. Returns null when nothing matches. */
export type VoicebotCommandResolver = (transcript: string) => VoicebotAppCommand | null;

export interface VoicebotConfig {
  apiKey?: string;
  sampleRate?: number;
  speechModel?: string; // e.g. 'universal-3-5-pro'
  mode?: 'min_latency' | 'balanced' | 'max_accuracy';
  languageCode?: string;
  /** Languages the user expects to speak. Empty lets Universal-3.5 Pro code-switch on its own. */
  languageCodes?: string[];
  keytermsPrompt?: string[];
  enableFallback?: boolean;
  engine?: SpeechEngineType;
}

export interface AssemblyAITurnMessage {
  type: 'Turn';
  turn_order?: number;
  end_of_turn: boolean;
  turn_is_formatted?: boolean;
  transcript: string;
  end_of_turn_confidence?: number;
  words?: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
    word_is_final?: boolean;
  }>;
}
