/**
 * Neural Audio Player & High-Quality Speech Synthesis Manager for ATLAS Web Client.
 *
 * Implements:
 * 1. Low-latency Web Audio API (AudioContext) streaming engine with 4ms anti-pop micro-fades.
 * 2. Gapless scheduled playback: chunks transition smoothly with zero clicks, DC-offset pops, or hardware re-init delays.
 * 3. Instant barge-in cancellation: immediately halts playback and clears queue on user interruption.
 * 4. Intelligent fallback voice picker: selects refined British/natural male voices (Jarvis persona)
 *    like "Google UK English Male", "Daniel", "Oliver", or "Natural" when neural audio is offline.
 */

export class NeuralAudioQueue {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private queue: Array<{
    audioBuffer: AudioBuffer;
    text?: string;
    index: number;
  }> = [];
  private activeSourceNodes: AudioBufferSourceNode[] = [];
  private isPlaying = false;
  private nextScheduleTime = 0;
  private onStateChange?: (isPlaying: boolean) => void;

  constructor(onStateChange?: (isPlaying: boolean) => void) {
    this.onStateChange = onStateChange;
  }

  private getAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(1.0, this.audioCtx.currentTime);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  resumeAudioContext(): void {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  async enqueue(
    base64Audio: string,
    _mimeType = 'audio/mp3',
    text?: string,
    index = 0
  ): Promise<void> {
    try {
      const binaryString = atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const ctx = this.getAudioContext();
      // Decode audio data asynchronously into clean PCM buffer (stripping container padding)
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

      this.queue.push({ audioBuffer, text, index });
      // Keep queue sorted by chunk index
      this.queue.sort((a, b) => a.index - b.index);

      if (!this.isPlaying) {
        this.startPlaybackLoop();
      } else {
        this.scheduleQueuedChunks();
      }
    } catch (err) {
      console.warn('[NeuralAudioQueue] Failed to decode audio chunk:', err);
    }
  }

  private startPlaybackLoop(): void {
    const ctx = this.getAudioContext();
    this.isPlaying = true;
    this.onStateChange?.(true);
    // Start immediate playback on first chunk
    this.nextScheduleTime = ctx.currentTime;
    this.scheduleQueuedChunks();
  }

  private scheduleQueuedChunks(): void {
    if (!this.isPlaying || !this.audioCtx || !this.masterGain) return;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const buffer = item.audioBuffer;
      const duration = buffer.duration;

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;

      // Create per-chunk gain node for micro-fade in & out (anti-pop)
      const chunkGain = this.audioCtx.createGain();
      source.connect(chunkGain);
      chunkGain.connect(this.masterGain);

      // Determine schedule time for gapless transition
      const startTime = Math.max(this.audioCtx.currentTime, this.nextScheduleTime);
      const endTime = startTime + duration;
      this.nextScheduleTime = endTime;

      // 4ms micro-fade in: eliminates DC-offset / leading impulse pop at start of chunk
      chunkGain.gain.setValueAtTime(0.0001, startTime);
      chunkGain.gain.exponentialRampToValueAtTime(1.0, startTime + 0.004);

      // 4ms micro-fade out: eliminates cutoff click at boundary
      if (duration > 0.01) {
        chunkGain.gain.setValueAtTime(1.0, endTime - 0.004);
        chunkGain.gain.exponentialRampToValueAtTime(0.0001, endTime);
      }

      source.start(startTime);
      this.activeSourceNodes.push(source);

      source.onended = () => {
        const idx = this.activeSourceNodes.indexOf(source);
        if (idx !== -1) {
          this.activeSourceNodes.splice(idx, 1);
        }
        chunkGain.disconnect();
        // If no more sources and queue empty, reset state
        if (this.activeSourceNodes.length === 0 && this.queue.length === 0) {
          this.isPlaying = false;
          this.nextScheduleTime = 0;
          this.onStateChange?.(false);
        }
      };
    }
  }

  stop(): void {
    this.queue = [];

    if (this.masterGain && this.audioCtx && this.audioCtx.state === 'running') {
      const now = this.audioCtx.currentTime;
      // 8ms smooth fade to 0 so there is no speaker click when stopping
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0.0, now + 0.008);
    }

    setTimeout(() => {
      for (const node of this.activeSourceNodes) {
        try {
          node.stop();
          node.disconnect();
        } catch (_e) {}
      }
      this.activeSourceNodes = [];

      if (this.masterGain && this.audioCtx && this.audioCtx.state === 'running') {
        this.masterGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
        this.masterGain.gain.setValueAtTime(1.0, this.audioCtx.currentTime);
      }
    }, 12);

    this.isPlaying = false;
    this.nextScheduleTime = 0;
    this.onStateChange?.(false);
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  getAudioData(): Uint8Array {
    if (!this.analyser || !this.isPlaying) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }
}

export class TextToSpeech {
  private isEnabled = true;
  private neuralQueue: NeuralAudioQueue;
  private hasReceivedNeuralAudio = false;
  private bestLocalVoice: SpeechSynthesisVoice | null = null;

  constructor(onPlaybackStateChange?: (isPlaying: boolean) => void) {
    this.neuralQueue = new NeuralAudioQueue(onPlaybackStateChange);
    this.initLocalVoices();
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  set enabled(val: boolean) {
    this.isEnabled = val;
    if (!val) {
      this.stop();
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  resetTurn(): void {
    this.hasReceivedNeuralAudio = false;
    this.stop();
  }

  resumeAudioContext(): void {
    this.neuralQueue.resumeAudioContext();
  }

  getAudioData(): Uint8Array {
    return this.neuralQueue.getAudioData();
  }

  /**
   * Enqueues an incoming neural audio chunk streamed from the backend.
   */
  enqueueNeuralAudio(
    base64Audio: string,
    mimeType = 'audio/mp3',
    text?: string,
    index = 0
  ): void {
    if (!this.isEnabled) return;
    this.hasReceivedNeuralAudio = true;

    // Only cancel fallback speech synthesis if it was actively running
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
    }
    this.neuralQueue.enqueue(base64Audio, mimeType, text, index);
  }

  /**
   * Stops both neural audio streaming and browser speech synthesis immediately.
   */
  stop(): void {
    this.neuralQueue.stop();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
    }
  }

  /**
   * Speaks via local Web Speech Synthesis ONLY if no neural audio arrived for this turn.
   */
  speakFallbackIfNoNeuralAudio(text: string): void {
    if (this.hasReceivedNeuralAudio) {
      // Neural audio is already playing or queued
      return;
    }
    this.speakLocal(text);
  }

  /**
   * Upgraded browser speech synthesis with Jarvis-like voice selection.
   */
  speakLocal(text: string): void {
    if (!this.isEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    this.stop();

    const cleaned = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[*_#~>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return;

    const isTelugu = /[\u0C00-\u0C7F]/.test(cleaned);
    const utterance = new SpeechSynthesisUtterance(cleaned);

    if (isTelugu) {
      utterance.lang = 'te-IN';
      utterance.rate = 0.95;
      utterance.pitch = 1.0;
      const teluguVoice = this.selectTeluguVoice();
      if (teluguVoice) {
        utterance.voice = teluguVoice;
      }
    } else {
      utterance.rate = 1.05;
      utterance.pitch = 0.98;
      const voice = this.bestLocalVoice || this.selectBestVoice();
      if (voice) {
        utterance.voice = voice;
      }
    }

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Native Telugu voice selector for local Web Speech Synthesis fallback.
   */
  private selectTeluguVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;

    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    // 1. Exact te-IN matching Mohan or Shruti
    const nativeNamed = voices.find(
      (v) =>
        (v.lang.startsWith('te') || v.lang.startsWith('te_')) &&
        (v.name.toLowerCase().includes('mohan') || v.name.toLowerCase().includes('shruti'))
    );
    if (nativeNamed) return nativeNamed;

    // 2. Any te-IN voice
    const teIn = voices.find(
      (v) => v.lang.toLowerCase() === 'te-in' || v.lang.toLowerCase() === 'te_in'
    );
    if (teIn) return teIn;

    // 3. Any voice with Telugu in name or lang
    const anyTelugu = voices.find(
      (v) =>
        v.lang.startsWith('te') ||
        v.lang.startsWith('te_') ||
        v.name.toLowerCase().includes('telugu')
    );
    return anyTelugu || null;
  }

  private initLocalVoices(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const load = () => {
        this.bestLocalVoice = this.selectBestVoice();
      };
      load();
      window.speechSynthesis.onvoiceschanged = load;
    }
  }

  /**
   * Intelligent voice hierarchy prioritizing refined, natural British/English voices.
   */
  private selectBestVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;

    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    // 1. Refined British English male voices (classic Jarvis)
    const jarvisKeywords = [
      'google uk english male',
      'daniel',
      'arthur',
      'oliver',
      'george',
      'ryan',
      'en-gb-ryan',
      'uk english male',
    ];

    for (const kw of jarvisKeywords) {
      const match = voices.find(
        (v) =>
          v.name.toLowerCase().includes(kw) ||
          (v.lang.startsWith('en-GB') && v.name.toLowerCase().includes(kw))
      );
      if (match) return match;
    }

    // 2. High-quality natural/neural British voices
    const britishNatural = voices.find(
      (v) =>
        (v.lang === 'en-GB' || v.lang.startsWith('en_GB')) &&
        (v.name.includes('Natural') || v.name.includes('Online'))
    );
    if (britishNatural) return britishNatural;

    // 3. Other natural/neural English voices
    const otherNatural = voices.find(
      (v) =>
        v.lang.startsWith('en') &&
        (v.name.includes('Natural') || v.name.includes('Neural') || v.name.includes('Google'))
    );
    if (otherNatural) return otherNatural;

    // 4. Any en-GB voice
    const anyBritish = voices.find((v) => v.lang.startsWith('en-GB') || v.lang.startsWith('en_GB'));
    if (anyBritish) return anyBritish;

    // 5. Fallback to any English voice
    return voices.find((v) => v.lang.startsWith('en')) || null;
  }
}
