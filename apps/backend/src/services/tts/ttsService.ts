import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface TTSOptions {
  voice?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  signal?: AbortSignal;
}

export interface TTSSynthesisResult {
  audio: Buffer;
  language: 'te' | 'en';
  voice: string;
  intent: string;
}

/**
 * Adaptive Neural Text-To-Speech Service for ATLAS
 *
 * Supports:
 * 1. Automatic Language Detection (Telugu script \u0C00-\u0C7F vs. English).
 * 2. Native Voice Routing:
 *    - Telugu: te-IN-MohanNeural (natural, expressive Telugu companion).
 *    - English: en-GB-RyanNeural (refined British Jarvis persona).
 * 3. Emotion, Intent & Situation Prosody Attunement:
 *    - Maps detected intent (calm_explanation, encouraging, direct_concise, lively)
 *      to subtle pitch and rate variations.
 */
export class TtsService {
  private clients: Map<string, MsEdgeTTS> = new Map();
  private currentVoice: string;
  private teluguVoice: string;
  private readonly isMock: boolean;

  constructor(
    defaultVoice = 'en-GB-RyanNeural',
    defaultTeluguVoice = 'te-IN-MohanNeural'
  ) {
    this.currentVoice = process.env.ATLAS_TTS_VOICE?.trim() || defaultVoice;
    this.teluguVoice = process.env.ATLAS_TTS_TELUGU_VOICE?.trim() || defaultTeluguVoice;
    this.isMock = process.env.NODE_ENV === 'test' && process.env.TEST_TTS !== 'true';
  }

  get voice(): string {
    return this.currentVoice;
  }

  set voice(v: string) {
    if (v && v !== this.currentVoice) {
      this.currentVoice = v;
      this.clients.delete(this.currentVoice);
    }
  }

  get teluguVoiceName(): string {
    return this.teluguVoice;
  }

  set teluguVoiceName(v: string) {
    if (v && v !== this.teluguVoice) {
      this.teluguVoice = v;
      this.clients.delete(this.teluguVoice);
    }
  }

  /**
   * Detects whether text contains Telugu Unicode script (\u0C00-\u0C7F).
   */
  containsTelugu(text: string): boolean {
    return /[\u0C00-\u0C7F]/.test(text);
  }

  /**
   * Detects language category ('te' or 'en').
   */
  detectLanguage(text: string): 'te' | 'en' {
    return this.containsTelugu(text) ? 'te' : 'en';
  }

  /**
   * Determines the optimal native neural voice based on language and script.
   */
  getVoiceForText(text: string, overrideVoice?: string): string {
    if (overrideVoice) return overrideVoice;
    if (this.containsTelugu(text)) {
      return this.teluguVoice;
    }
    return this.currentVoice;
  }

  /**
   * Analyzes context, intent, and sentiment to compute natural prosody adjustments.
   */
  detectIntentAndProsody(
    text: string,
    language: 'te' | 'en'
  ): { pitch: string; rate: string; intent: string } {
    const lower = text.toLowerCase();

    // 1. Explanation / Educational tone
    const isExplanation =
      language === 'te'
        ? /ఎందుకంటే|అర్థం|వివరణ|ఉదాహరణ|ముఖ్యంగా|తెలుసుకోవాలి|ఎలాగంటే|అంటే|వివరిస్తా/.test(text)
        : /\b(because|concept|explains|meaning|understand|for example|specifically|essentially|architecture|mechanism|reason)\b/i.test(lower);

    if (isExplanation) {
      return {
        intent: 'calm_explanation',
        pitch: language === 'te' ? '-1Hz' : '-2Hz',
        rate: language === 'te' ? '-4%' : '-2%', // Calm pacing ensures Telugu conjuncts and technical analogies are clear
      };
    }

    // 2. Encouraging / Uplifting tone
    const isEncouraging =
      language === 'te'
        ? /బాగుంది|మంచిది|అద్భుతం|ఖచ్చితంగా|సరిగ్గా|ధన్యవాదాలు|హర్షం|ఆనందం/.test(text)
        : /\b(great|awesome|excellent|well done|perfect|good job|glad|welcome|delighted|congratulations)\b/i.test(lower);

    if (isEncouraging) {
      return {
        intent: 'encouraging',
        pitch: '+3Hz',
        rate: language === 'te' ? '+1%' : '+3%',
      };
    }

    // 3. Direct / Technical troubleshooting
    const isDirect =
      language === 'te'
        ? /పరిష్కారం|లోపం|ఎర్రర్|కోడ్|స్టేటస్|రన్|చేయండి/.test(text)
        : /\b(error|failed|issue|fix|status|command|terminal|run|npm|git|port|return|patch)\b/i.test(lower);

    if (isDirect) {
      return {
        intent: 'direct_concise',
        pitch: '+0Hz',
        rate: language === 'te' ? '+2%' : '+5%',
      };
    }

    // 4. Default lively / conversational partner
    return {
      intent: 'lively',
      pitch: language === 'te' ? '+1Hz' : '+2Hz',
      rate: language === 'te' ? '+0%' : '+2%',
    };
  }

  private async getClientForVoice(voiceName: string): Promise<MsEdgeTTS | null> {
    if (this.isMock) return null;
    let client = this.clients.get(voiceName);
    if (!client) {
      try {
        client = new MsEdgeTTS();
        await client.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        this.clients.set(voiceName, client);
      } catch (err) {
        return null;
      }
    }
    return client;
  }

  /**
   * Sanitizes markdown text for natural, clean speech synthesis across English and Telugu.
   */
  cleanTextForSpeech(rawText: string): string {
    let text = rawText
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/`([^`]+)`/g, '$1') // Inline code to plain text
      .replace(/https?:\/\/\S+/g, 'link') // URLs to 'link'
      .replace(/[*_#~]/g, '') // Markdown punctuation
      .replace(/^>\s*/gm, '') // Markdown blockquotes
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Markdown links
      .replace(/[\u2018\u2019]/g, "'") // Normalize smart single quotes / apostrophes
      .replace(/[\u201C\u201D]/g, '"') // Normalize smart double quotes
      .replace(/\s+/g, ' ')
      .trim();

    // Strip leading punctuation/symbols that cause TTS start-of-sentence acoustic pops/glitches
    text = text.replace(/^[\s,;:–—"'“‘”’?!\-•*.\u2026]+/, '').trim();

    // Escape essential XML entities so SSML parser never fails on & < >
    text = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return text;
  }

  /**
   * Synthesizes text with automatic language detection, native voice routing, and prosody metadata.
   */
  async synthesizeWithMetadata(
    text: string,
    options?: TTSOptions
  ): Promise<TTSSynthesisResult | null> {
    if (options?.signal?.aborted) {
      return null;
    }

    const cleaned = this.cleanTextForSpeech(text);
    if (!cleaned || cleaned.length < 2) {
      return null;
    }

    const language = this.detectLanguage(cleaned);
    const targetVoice = options?.voice || this.getVoiceForText(cleaned);
    const { pitch, rate, intent } = this.detectIntentAndProsody(cleaned, language);

    // In automated unit test mode, return null unless TEST_TTS is explicitly enabled
    if (process.env.NODE_ENV === 'test' && process.env.TEST_TTS !== 'true') {
      return null;
    }

    // In unit test or mock mode with TEST_TTS=true, return mock result
    if (this.isMock) {
      return {
        audio: Buffer.from(`MOCK_AUDIO_MP3[${cleaned}]`),
        language,
        voice: targetVoice,
        intent,
      };
    }

    try {
      const client = await this.getClientForVoice(targetVoice);
      if (!client) return null;

      const finalPitch = options?.pitch || pitch;
      const finalRate = options?.rate || rate;

      const { audioStream } = client.toStream(cleaned, {
        pitch: finalPitch,
        rate: finalRate,
      });

      const audioBuffer = await new Promise<Buffer | null>((resolve) => {
        const chunks: Buffer[] = [];

        const onAbort = () => {
          audioStream.destroy();
          resolve(null);
        };

        if (options?.signal) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        audioStream.on('data', (chunk: Buffer) => {
          if (options?.signal?.aborted) {
            audioStream.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });

        audioStream.on('end', () => {
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          if (options?.signal?.aborted) {
            resolve(null);
          } else {
            resolve(Buffer.concat(chunks));
          }
        });

        audioStream.on('error', () => {
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
          resolve(null);
        });
      });

      if (!audioBuffer) return null;

      return {
        audio: audioBuffer,
        language,
        voice: targetVoice,
        intent,
      };
    } catch {
      return null;
    }
  }

  /**
   * Synthesizes a text segment to an MP3 Buffer (backwards-compatible API).
   */
  async synthesize(text: string, options?: TTSOptions): Promise<Buffer | null> {
    const res = await this.synthesizeWithMetadata(text, options);
    return res?.audio ?? null;
  }
}

export const ttsService = new TtsService();
