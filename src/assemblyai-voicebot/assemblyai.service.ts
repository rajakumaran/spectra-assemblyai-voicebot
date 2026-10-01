import { Injectable, signal } from '@angular/core';
import {
  AssemblyAITurnMessage, SpeechEngineType, SyncTranscriptResult,
  VOICE_LANGUAGES, VoicebotConfig, VoicebotStatus
} from './voicebot.types';
import { encodeWav } from './pcm-wav';

/**
 * Sync STT posts one short clip and returns the transcript in the same response - no WebSocket, no
 * polling - which suits push-and-talk commands better than a streaming session.
 *
 * The two project notes disagree on the path: "52.a Instructions for Sync STT" says `/v1/transcribe`
 * while "52. AssemblyAI Integration" says `/transcribe`. A wrong path is a silent total failure, so
 * the first is tried and the second is used if it 404s, and the working one is remembered.
 */
const SYNC_STT_PATHS = ['https://sync.assemblyai.com/v1/transcribe', 'https://sync.assemblyai.com/transcribe'];

/**
 * Universal-3.5 Pro ends a turn after about a second of silence (`max_turn_silence` defaults to
 * 1000 ms), and the voicebot treats a finished turn as a finished command - so pausing to switch
 * language mid-sentence cuts the speaker off. These widen that window while MULTI_LANGUAGE_SUPPORT
 * is on; English-only sessions keep the snappier default. Both are clamped 50-10000 ms by the API.
 */
const MULTILANG_MIN_TURN_SILENCE_MS = 1500;
const MULTILANG_MAX_TURN_SILENCE_MS = 4000;

/** iPadOS reports itself as a Mac, so touch points are what separate it from a desktop Safari. */
const IS_IOS = typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
   ((navigator as any).platform === 'MacIntel' && navigator.maxTouchPoints > 1));

@Injectable({
  providedIn: 'root'
})
export class AssemblyAIService {
  public status = signal<VoicebotStatus>('idle');
  public partialTranscript = signal<string>('');
  public finalTranscript = signal<string>('');
  public errorMessage = signal<string | null>(null);
  public activeProvider = signal<'assemblyai' | 'browser-speech'>('browser-speech');

  // Configurable Engine Switch: 'device' (Free & Unlimited Web Speech API) vs 'assemblyai' (Cloud Universal-3.5)
  public selectedEngine = signal<SpeechEngineType>('device');
  public isCloudAssemblyAIEnabled = signal<boolean>(false);
  public isCloudCheckComplete = signal<boolean>(false);

  /**
   * Gated by the MULTI_LANGUAGE_SUPPORT environment variable, which must be exactly the lowercase
   * string 'true'. While it is off, this service behaves exactly as it did before multi-language was
   * added: device speech in en-US, or the Universal-3.5 streaming socket with no language field.
   */
  public isMultiLanguageEnabled = signal<boolean>(false);

  /**
   * Languages the user expects to speak, as ISO 639-1 codes. Empty means "let the model decide":
   * Universal-3.5 Pro code-switches across its 18 languages natively and falls back to Universal-2
   * for the other 99, so naming languages only narrows the search when the user already knows.
   */
  public selectedLanguages = signal<string[]>([]);
  public readonly availableLanguages = VOICE_LANGUAGES;

  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  /** Silent sink that keeps the ScriptProcessor alive without routing the mic to the speakers. */
  private micSinkNode: GainNode | null = null;

  /** Non-null only while Sync STT is recording; captured PCM16 accumulates here until the mic stops. */
  private syncChunks: Int16Array[] | null = null;
  /** Index into SYNC_STT_PATHS that last worked, so the 404 probe happens at most once. */
  private syncPathIndex = 0;
  /** Keyterms for the pending Sync STT upload, kept from startListening until the clip is sent. */
  private pendingKeyterms: string[] = [];

  // Browser Web Speech API fallback instance
  private speechRecognition: any = null;

  // AssemblyAI Settings
  private apiKey: string = '';
  private sampleRate = 16000;
  private speechModel = 'universal-3-5-pro';
  private mode: 'min_latency' | 'balanced' | 'max_accuracy' = 'balanced';

  // Listeners for finalized turns
  private onTurnCallbacks: Array<(turn: AssemblyAITurnMessage) => void> = [];

  constructor() {
    if (typeof window !== 'undefined') {
      const savedEngine = localStorage.getItem('VOICEBOT_ENGINE');
      if (savedEngine === 'assemblyai' || savedEngine === 'device' || savedEngine === 'assemblyai-sync') {
        this.selectedEngine.set(savedEngine);
      }

      const win = window as any;

      // Strictly the lowercase string 'true', so a stray 'TRUE' or '1' cannot switch this on by accident
      const rawMultiLang = win.MULTI_LANGUAGE_SUPPORT ??
                           win.__env?.MULTI_LANGUAGE_SUPPORT ??
                           win._env_?.MULTI_LANGUAGE_SUPPORT ??
                           localStorage.getItem('MULTI_LANGUAGE_SUPPORT');
      this.isMultiLanguageEnabled.set(String(rawMultiLang) === 'true');

      const savedLanguages = localStorage.getItem('VOICEBOT_LANGUAGES');
      if (savedLanguages) {
        const codes = savedLanguages.split(',').filter(c => VOICE_LANGUAGES.some(l => l.code === c));
        if (codes.length) this.selectedLanguages.set(codes);
      }
      const envKey = win.ASSEMBLYAI_API_KEY ||
                     win.__env?.ASSEMBLYAI_API_KEY ||
                     win._env_?.ASSEMBLYAI_API_KEY;

      if (envKey) {
        this.apiKey = String(envKey).trim();
      } else {
        const savedKey = localStorage.getItem('ASSEMBLYAI_API_KEY');
        if (savedKey) {
          this.apiKey = savedKey.trim();
        }
      }

      // Check if AssemblyAI cloud token minting is enabled in Vercel environment
      this.checkCloudAssemblyAIStatus();
    }
  }

  /**
   * Checks whether AssemblyAI is enabled in Vercel Cloud via ENABLE_ASSEMBLYAI=true
   */
  public async checkCloudAssemblyAIStatus(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
      const res = await fetch('/api/assemblyai-token?check=status', {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        const enabled = Boolean(data.enabled);
        this.isCloudAssemblyAIEnabled.set(enabled);
        this.isCloudCheckComplete.set(true);

        // The deployed MULTI_LANGUAGE_SUPPORT value is authoritative over any local window/storage guess
        if (data.multiLanguage !== undefined) {
          this.isMultiLanguageEnabled.set(data.multiLanguage === true);
        }

        // If Cloud is disabled via Vercel env, lock engine to free 'device'
        if (!enabled && this.selectedEngine() === 'assemblyai') {
          this.setEngine('device');
        }
        // Sync STT exists only to serve multi-language; without the flag fall back to the engine
        // the app shipped with, so a stale localStorage value cannot strand the user on it.
        if (!this.isMultiLanguageEnabled() && this.selectedEngine() === 'assemblyai-sync') {
          this.setEngine(enabled ? 'assemblyai' : 'device');
        }
        return enabled;
      }
    } catch (e) {
      // Local development or offline fallback
    }
    this.isCloudAssemblyAIEnabled.set(false);
    this.isCloudCheckComplete.set(true);
    return false;
  }

  public setEngine(engine: SpeechEngineType): void {
    this.selectedEngine.set(engine);
    if (typeof window !== 'undefined') {
      localStorage.setItem('VOICEBOT_ENGINE', engine);
    }
  }

  public toggleEngine(): void {
    // If cloud is disabled in Vercel, notify and keep on device
    if (!this.isCloudAssemblyAIEnabled() && this.selectedEngine() === 'device') {
      return;
    }
    // With MULTI_LANGUAGE_SUPPORT on, Sync STT joins the rotation as the multilingual option
    const order: SpeechEngineType[] = this.isMultiLanguageEnabled()
      ? ['device', 'assemblyai', 'assemblyai-sync']
      : ['device', 'assemblyai'];
    const next = order[(order.indexOf(this.selectedEngine()) + 1) % order.length];
    this.setEngine(next);
  }

  /** Languages the user expects to speak. Empty lets Universal-3.5 Pro code-switch unaided. */
  public setLanguages(codes: string[]): void {
    const valid = codes.filter(c => VOICE_LANGUAGES.some(l => l.code === c));
    this.selectedLanguages.set(valid);
    if (typeof window !== 'undefined') {
      if (valid.length) localStorage.setItem('VOICEBOT_LANGUAGES', valid.join(','));
      else localStorage.removeItem('VOICEBOT_LANGUAGES');
    }
  }

  public toggleLanguage(code: string): void {
    const current = this.selectedLanguages();
    this.setLanguages(current.includes(code) ? current.filter(c => c !== code) : [...current, code]);
  }

  public setApiKey(key: string): void {
    this.apiKey = key.trim();
    if (typeof window !== 'undefined') {
      if (this.apiKey) {
        localStorage.setItem('ASSEMBLYAI_API_KEY', this.apiKey);
      } else {
        localStorage.removeItem('ASSEMBLYAI_API_KEY');
      }
    }
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public onTurn(callback: (turn: AssemblyAITurnMessage) => void): () => void {
    this.onTurnCallbacks.push(callback);
    return () => {
      this.onTurnCallbacks = this.onTurnCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Start listening using configured engine:
   * - 'device': Free Web Speech API (zero token/API cost)
   * - 'assemblyai': Universal-3.5 Streaming WebSocket (when ENABLE_ASSEMBLYAI=true)
   */
  public async startListening(config?: VoicebotConfig): Promise<void> {
    if (this.status() === 'listening' || this.status() === 'processing') return;

    this.errorMessage.set(null);
    this.partialTranscript.set('');
    this.finalTranscript.set('');

    if (config?.apiKey) {
      this.setApiKey(config.apiKey);
    }
    if (config?.mode) {
      this.mode = config.mode;
    }
    if (config?.speechModel) {
      this.speechModel = config.speechModel;
    }
    if (config?.engine) {
      this.setEngine(config.engine);
    }
    if (config?.languageCodes) {
      this.setLanguages(config.languageCodes);
    }
    this.pendingKeyterms = config?.keytermsPrompt || [];

    this.status.set('processing');

    // 1. SYNC STT: one short clip, one request, multilingual. Only when MULTI_LANGUAGE_SUPPORT is on.
    if (this.isMultiLanguageEnabled() && this.selectedEngine() === 'assemblyai-sync' && this.isCloudAssemblyAIEnabled()) {
      try {
        await this.startSyncRecording();
        this.activeProvider.set('assemblyai');
        return;
      } catch (err: any) {
        console.warn('Sync STT capture failed, falling back to free device speech:', err?.message || err);
      }
    }

    // 2. FREE DEVICE MODE: If engine is 'device' OR cloud AssemblyAI is disabled in Vercel
    if (this.selectedEngine() === 'device' || !this.isCloudAssemblyAIEnabled()) {
      this.startBrowserSpeechRecognition();
      this.activeProvider.set('browser-speech');
      return;
    }

    // 3. ASSEMBLYAI CLOUD MODE (Only executed when explicitly selected AND ENABLE_ASSEMBLYAI=true)
    try {
      const token = await this.fetchStreamingToken();
      if (token) {
        await this.startAssemblyAIStreamWithToken(token, config);
        this.activeProvider.set('assemblyai');
        return;
      }
    } catch (tokenErr: any) {
      console.warn('AssemblyAI Token request failed, falling back to free device speech:', tokenErr?.message || tokenErr);
    }

    // 4. Fallback to direct key if configured
    if (this.apiKey) {
      try {
        const tokenRes = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=300', {
          headers: { 'Authorization': this.apiKey }
        });
        if (tokenRes.ok) {
          const data = await tokenRes.json();
          if (data.token) {
            await this.startAssemblyAIStreamWithToken(data.token, config);
            this.activeProvider.set('assemblyai');
            return;
          }
        }
      } catch (err: any) {
        console.warn('AssemblyAI direct token minting failed:', err);
      }
    }

    // 5. Fallback: Free Browser Web Speech API
    this.startBrowserSpeechRecognition();
    this.activeProvider.set('browser-speech');
  }

  /**
   * Fetch temporary short-lived token from Vercel Serverless Function
   */
  private async fetchStreamingToken(): Promise<string | null> {
    try {
      const res = await fetch('/api/assemblyai-token', {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      return data.token || null;
    } catch (e: any) {
      // Re-throw so startListening can decide fallback
      throw e;
    }
  }

  /**
   * Stop listening and cleanly terminate sessions, ensuring any in-flight transcript is processed
   */
  public async stopListening(): Promise<void> {
    // 0. Claim any Sync STT recording up front. Taking the buffer here means a second stopListening()
    //    call - the voicebot makes one after every command - cannot upload the same clip twice.
    const pendingSync = this.syncChunks;
    this.syncChunks = null;

    // 1. Immediately finalize any pending partial transcript so the user's spoken command is never dropped
    const pendingText = this.partialTranscript().trim();
    if (pendingText) {
      this.finalTranscript.set(pendingText);
      this.partialTranscript.set('');
      const syntheticTurn: AssemblyAITurnMessage = {
        type: 'Turn',
        end_of_turn: true,
        transcript: pendingText
      };
      this.onTurnCallbacks.forEach(cb => cb(syntheticTurn));
    }

    this.status.set('idle');

    // 2. Cleanly terminate AssemblyAI WebSocket
    if (this.ws) {
      const activeWs = this.ws;
      this.ws = null;
      try {
        if (activeWs.readyState === WebSocket.OPEN) {
          // Send ForceEndpoint and Terminate as mandated by AssemblyAI docs
          activeWs.send(JSON.stringify({ type: 'ForceEndpoint' }));
          activeWs.send(JSON.stringify({ type: 'Terminate' }));
          // Give brief grace for server to send final packets before closing
          setTimeout(() => {
            try {
              activeWs.close(1000, 'Session stopped cleanly');
            } catch (e) {}
          }, 200);
        } else {
          activeWs.close();
        }
      } catch (e) {
        // ignore send error on close
      }
    }

    // 3. Stop audio capture
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.micSinkNode) {
      this.micSinkNode.disconnect();
      this.micSinkNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }

    // 4. Stop browser speech recognition
    if (this.speechRecognition) {
      try {
        this.speechRecognition.stop();
      } catch (e) {}
      this.speechRecognition = null;
    }

    // 5. The mic is now released, so upload the Sync STT clip and emit its transcript as a turn
    if (pendingSync) {
      await this.transcribeSyncClip(pendingSync);
    }
  }

  /**
   * Connect to AssemblyAI Streaming v3 WebSocket using single-use token
   */
  private async startAssemblyAIStreamWithToken(token: string, config?: VoicebotConfig): Promise<void> {
    // Build WebSocket URL
    let wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${this.sampleRate}&speech_model=${this.speechModel}&mode=${this.mode}&token=${encodeURIComponent(token)}`;
    // One chosen language pins the stream; several (or none) let Universal-3.5 Pro code-switch natively
    const chosen = this.selectedLanguages();
    const pinned = config?.languageCode || (this.isMultiLanguageEnabled() && chosen.length === 1 ? chosen[0] : '');
    if (pinned) {
      wsUrl += `&language_code=${encodeURIComponent(pinned)}`;
    }
    // Room to pause mid-sentence while switching language, instead of being cut off after ~1 second
    if (this.isMultiLanguageEnabled()) {
      wsUrl += `&min_turn_silence=${MULTILANG_MIN_TURN_SILENCE_MS}&max_turn_silence=${MULTILANG_MAX_TURN_SILENCE_MS}`;
    }
    // Keyterms prompting biases recognition toward the app's own vocabulary (max 100 terms, 50 chars each)
    const keyterms = (config?.keytermsPrompt || []).filter(t => t && t.length <= 50).slice(0, 100);
    if (keyterms.length) {
      wsUrl += `&keyterms_prompt=${encodeURIComponent(JSON.stringify(keyterms))}`;
    }

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket creation failed'));

      const timeout = setTimeout(() => {
        reject(new Error('AssemblyAI WebSocket connection timeout (10s)'));
      }, 10000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.status.set('listening');
        resolve();
      };

      this.ws.onerror = (err) => {
        clearTimeout(timeout);
        this.status.set('error');
        this.errorMessage.set('AssemblyAI connection error. Falling back to browser speech.');
        reject(err);
      };

      this.ws.onclose = (event) => {
        if (event.code !== 1000 && event.code !== 1005) {
          console.log(`AssemblyAI WebSocket closed: code ${event.code} (${event.reason})`);
        }
        if (this.status() === 'listening') {
          this.status.set('idle');
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'Turn') {
            const isFinal = !!msg.end_of_turn;
            const text = (msg.transcript || '').trim();

            if (isFinal) {
              if (text) {
                this.finalTranscript.set(text);
                this.partialTranscript.set('');
                this.onTurnCallbacks.forEach(cb => cb(msg));
              }
            } else {
              this.partialTranscript.set(text);
            }
          }
        } catch (e) {
          console.error('Failed to parse AssemblyAI message:', e);
        }
      };
    });

    // Start Microphone capture & PCM conversion
    await this.startMicrophoneCapture();
  }

  /**
   * Sync STT records first and uploads once, so capture only has to fill a buffer. Reuses the same
   * mic graph as streaming; the presence of `syncChunks` is what makes the processor accumulate
   * instead of sending.
   */
  private async startSyncRecording(): Promise<void> {
    this.syncChunks = [];
    await this.startMicrophoneCapture();
    this.status.set('listening');
  }

  /**
   * Posts the clip and emits the transcript as a finalized turn, so callers cannot tell it came from
   * a single request rather than a stream.
   */
  private async transcribeSyncClip(chunks: Int16Array[]): Promise<void> {
    const wav = encodeWav(chunks, this.sampleRate);
    if (!wav) {
      this.status.set('idle');
      return;
    }

    this.status.set('processing');
    const languages = this.selectedLanguages();
    const keyterms = this.pendingKeyterms.filter(t => t && t.length <= 50).slice(0, 100);
    // Only send what the user actually chose; an empty list lets U3.5 Pro code-switch natively
    const config: Record<string, unknown> = {};
    if (languages.length) config['language_codes'] = languages;
    if (keyterms.length) config['keyterms_prompt'] = keyterms;

    try {
      const result = await this.postSyncClip(wav, config);
      const text = (result.text || '').trim();
      if (!text) {
        if (result.error_code) {
          this.errorMessage.set(`Sync STT: ${result.error_code}`);
          this.status.set('error');
          return;
        }
        this.status.set('idle');
        return;
      }

      this.finalTranscript.set(text);
      this.partialTranscript.set('');
      this.status.set('idle');
      this.onTurnCallbacks.forEach(cb => cb({ type: 'Turn', end_of_turn: true, transcript: text }));
    } catch (err: any) {
      console.warn('Sync STT transcription failed:', err?.message || err);
      this.errorMessage.set('Could not transcribe that clip. Try again or switch engine.');
      this.status.set('error');
    }
  }

  /**
   * Prefers the serverless proxy so the API key stays on the server; falls back to calling AssemblyAI
   * directly when a key has been supplied client-side (local development).
   */
  private async postSyncClip(wav: Uint8Array, config: Record<string, unknown>): Promise<SyncTranscriptResult> {
    const wavBlob = new Blob([wav as BlobPart], { type: 'audio/wav' });

    const proxyRes = await fetch('/api/assemblyai-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-AAI-Config': JSON.stringify(config),
      },
      body: wavBlob,
    }).catch(() => null);

    if (proxyRes?.ok) return await proxyRes.json();

    if (!this.apiKey) {
      throw new Error(proxyRes ? `proxy HTTP ${proxyRes.status}` : 'sync proxy unreachable and no local API key');
    }

    const form = new FormData();
    form.append('audio', wavBlob, 'command.wav');
    form.append('config', new Blob([JSON.stringify(config)], { type: 'application/json' }));

    for (let attempt = 0; attempt < SYNC_STT_PATHS.length; attempt++) {
      const url = SYNC_STT_PATHS[(this.syncPathIndex + attempt) % SYNC_STT_PATHS.length];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': this.apiKey, 'X-AAI-Model': this.speechModel },
        body: form,
      });
      // Only a missing route justifies trying the other spelling; real errors should surface
      if (res.status === 404 || res.status === 405) continue;
      this.syncPathIndex = (this.syncPathIndex + attempt) % SYNC_STT_PATHS.length;
      return await res.json();
    }
    throw new Error('no Sync STT endpoint responded');
  }

  /**
   * Browser microphone capture & downsampling to 16 kHz 16-bit PCM (S16LE)
   */
  private async startMicrophoneCapture(): Promise<void> {
    // Requesting echo cancellation makes iOS switch on its voice-processing audio unit, which puts
    // the audio session into a voice-chat mode: whatever else is playing ducks to silence and output
    // drops to the earpiece. The music has to keep playing while the user talks to the bot, so iOS
    // gets a plain capture instead. The trade is that the mic there also hears the track.
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: IS_IOS
        ? { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();

    // Ensure audio context is running (fixes mobile/browser suspended state)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const sourceSampleRate = this.audioContext.sampleRate;
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Buffer size 4096 gives ~85-90ms at 44.1/48kHz, optimal for AssemblyAI 50-1000ms chunk rule
    const bufferSize = 4096;
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.processorNode.onaudioprocess = (e: AudioProcessingEvent) => {
      // Sync STT buffers the whole clip; streaming ships each chunk as it arrives
      const recording = this.syncChunks;
      if (!recording && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = this.resampleAndConvertToPCM16(inputData, sourceSampleRate, this.sampleRate);
      if (pcm16.byteLength === 0) return;

      if (recording) recording.push(pcm16);
      else this.ws!.send(pcm16.buffer);
    };

    // A ScriptProcessor only keeps firing while it has a path to the destination, but the microphone
    // itself must never reach the speakers - send it through a silent gain node rather than straight out.
    this.micSinkNode = this.audioContext.createGain();
    this.micSinkNode.gain.value = 0;
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.micSinkNode);
    this.micSinkNode.connect(this.audioContext.destination);
  }

  /**
   * Downsamples input Float32Array to 16 kHz and converts to Int16 PCM bytes
   */
  private resampleAndConvertToPCM16(
    input: Float32Array,
    fromSampleRate: number,
    toSampleRate: number
  ): Int16Array {
    if (fromSampleRate === toSampleRate) {
      const output = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return output;
    }

    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.round(input.length / ratio);
    const output = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const originIndex = Math.floor(i * ratio);
      const s = Math.max(-1, Math.min(1, input[originIndex]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    return output;
  }

  /**
   * Zero-setup fallback using Web Speech API
   */
  private startBrowserSpeechRecognition(): void {
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      this.errorMessage.set('Speech recognition is not supported in this browser.');
      this.status.set('error');
      return;
    }

    this.speechRecognition = new SpeechRecognitionClass();
    this.speechRecognition.continuous = true;
    this.speechRecognition.interimResults = true;
    // Web Speech recognises one language at a time, so the first choice wins. Without the
    // MULTI_LANGUAGE_SUPPORT flag this stays en-US exactly as before.
    const firstChoice = this.isMultiLanguageEnabled() ? this.selectedLanguages()[0] : undefined;
    this.speechRecognition.lang =
      VOICE_LANGUAGES.find(l => l.code === firstChoice)?.webSpeechTag || 'en-US';

    this.speechRecognition.onstart = () => {
      this.status.set('listening');
    };

    this.speechRecognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          const finalTrim = transcript.trim();
          if (finalTrim) {
            this.finalTranscript.set(finalTrim);
            this.partialTranscript.set('');
            // Emit synthetic turn message
            const syntheticTurn: AssemblyAITurnMessage = {
              type: 'Turn',
              end_of_turn: true,
              transcript: finalTrim
            };
            this.onTurnCallbacks.forEach(cb => cb(syntheticTurn));
          }
        } else {
          interim += transcript;
          this.partialTranscript.set(interim.trim());
        }
      }
    };

    this.speechRecognition.onerror = (event: any) => {
      console.warn('Browser SpeechRecognition event error:', event.error);
      if (event.error !== 'no-speech') {
        this.errorMessage.set(`Speech recognition: ${event.error}`);
      }
    };

    this.speechRecognition.onend = () => {
      // If stopped while there was a pending interim transcript, finalize it!
      const pending = this.partialTranscript().trim();
      if (pending) {
        this.finalTranscript.set(pending);
        this.partialTranscript.set('');
        const syntheticTurn: AssemblyAITurnMessage = {
          type: 'Turn',
          end_of_turn: true,
          transcript: pending
        };
        this.onTurnCallbacks.forEach(cb => cb(syntheticTurn));
      }

      if (this.status() === 'listening') {
        try {
          this.speechRecognition.start();
        } catch (e) {}
      }
    };

    try {
      this.speechRecognition.start();
    } catch (e: any) {
      this.errorMessage.set(`Speech recognition failed: ${e?.message}`);
      this.status.set('error');
    }
  }
}
