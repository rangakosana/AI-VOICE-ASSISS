import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TtsService, ttsService } from '../src/services/tts/ttsService.js';
import {
  isServerAudioChunkMessage,
  isServerVoiceMessage,
  type ServerAudioChunkMessage,
} from '../src/types/protocol.js';

describe('Neural Text-To-Speech (TTS) Service & Audio Protocol', () => {
  it('1. Initializes with British Jarvis voice (en-GB-RyanNeural) by default', () => {
    const service = new TtsService();
    assert.equal(service.voice, 'en-GB-RyanNeural');
  });

  it('2. Supports voice configuration updates dynamically', () => {
    const service = new TtsService('en-GB-RyanNeural');
    service.voice = 'en-US-AndrewNeural';
    assert.equal(service.voice, 'en-US-AndrewNeural');
  });

  it('3. Cleans markdown, inline code, and URLs for natural speech synthesis', () => {
    const rawMarkdown = `
# System Check
Hello **user**, here is the code:
\`\`\`ts
const x = 10;
\`\`\`
Check out \`process.env\` and visit https://example.com/test or [Atlas Docs](https://atlas.ai/docs).
*All systems nominal.*
    `.trim();

    const cleaned = ttsService.cleanTextForSpeech(rawMarkdown);
    assert.ok(!cleaned.includes('```'), 'Code fences must be stripped');
    assert.ok(!cleaned.includes('const x = 10'), 'Code block content must be omitted');
    assert.ok(!cleaned.includes('**'), 'Markdown bold symbols must be stripped');
    assert.ok(cleaned.includes('process.env'), 'Inline code text must be preserved');
    assert.ok(cleaned.includes('Atlas Docs'), 'Markdown link label must be preserved');
    assert.ok(cleaned.includes('link'), 'Bare URLs must be replaced with spoken word');
  });

  it('4. Correctly validates and typeguards server.audio.chunk messages', () => {
    const audioChunkMsg: ServerAudioChunkMessage = {
      type: 'server.audio.chunk',
      timestamp: new Date().toISOString(),
      payload: {
        responseId: 'resp_tts_1',
        index: 0,
        audio: 'AQIDBA==',
        mimeType: 'audio/mp3',
        text: 'Greetings. How may I assist you today?',
        isFinal: false,
      },
    };

    assert.equal(isServerAudioChunkMessage(audioChunkMsg), true);
    assert.equal(isServerVoiceMessage(audioChunkMsg), true);

    const nonAudioMsg = {
      type: 'server.response.delta',
      timestamp: new Date().toISOString(),
      payload: { delta: 'hi' },
    };
    assert.equal(isServerAudioChunkMessage(nonAudioMsg as any), false);
  });

  it('5. Handles AbortSignal promptly to support instant barge-in', async () => {
    const service = new TtsService();
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const result = await service.synthesize('This synthesis was aborted.', {
      signal: abortCtrl.signal,
    });
    assert.equal(result, null, 'Aborted synthesis must return null immediately');
  });

  it('6. Strips leading orphaned punctuation and escapes XML entities to prevent acoustic pops', () => {
    const rawPunct = `..."Why? That's right & ready <now>."`;
    const cleaned = ttsService.cleanTextForSpeech(rawPunct);
    assert.ok(!cleaned.startsWith('.'), 'Leading dots must be stripped');
    assert.ok(!cleaned.startsWith('"'), 'Leading quotes must be stripped');
    assert.ok(cleaned.includes('&amp;'), 'Ampersand must be XML-escaped');
    assert.ok(cleaned.includes('&lt;now&gt;'), 'Angle brackets must be XML-escaped');
    assert.ok(cleaned.includes("That's right"), 'Contractions and apostrophes must be preserved');
  });

  it('7. Detects Telugu script and routes to native Telugu voice (te-IN-MohanNeural)', () => {
    const teluguText = 'క్వాంటం కంప్యూటింగ్ అనేది సాధారణ కంప్యూటర్ల కంటే భిన్నమైనది.';
    assert.equal(ttsService.containsTelugu(teluguText), true);
    assert.equal(ttsService.detectLanguage(teluguText), 'te');
    assert.equal(ttsService.getVoiceForText(teluguText), 'te-IN-MohanNeural');

    const englishText = 'Quantum computing operates on qubits rather than classical bits.';
    assert.equal(ttsService.containsTelugu(englishText), false);
    assert.equal(ttsService.detectLanguage(englishText), 'en');
    assert.equal(ttsService.getVoiceForText(englishText), 'en-GB-RyanNeural');
  });

  it('8. Adapts intent and prosody according to language and emotional context', () => {
    // 1. Explanation in Telugu
    const teExplanation = ttsService.detectIntentAndProsody('ఎందుకంటే ఇది చాలా ముఖ్యమైన కాన్సెప్ట్.', 'te');
    assert.equal(teExplanation.intent, 'calm_explanation');
    assert.equal(teExplanation.rate, '-4%');
    assert.equal(teExplanation.pitch, '-1Hz');

    // 2. Explanation in English
    const enExplanation = ttsService.detectIntentAndProsody('This mechanism explains why the architecture is scalable.', 'en');
    assert.equal(enExplanation.intent, 'calm_explanation');
    assert.equal(enExplanation.rate, '-2%');

    // 3. Encouraging in Telugu and English
    const teEncouraging = ttsService.detectIntentAndProsody('చాలా బాగుంది! మంచి ప్రయత్నం.', 'te');
    assert.equal(teEncouraging.intent, 'encouraging');
    assert.equal(teEncouraging.pitch, '+3Hz');

    const enEncouraging = ttsService.detectIntentAndProsody('Great job, excellent progress!', 'en');
    assert.equal(enEncouraging.intent, 'encouraging');
    assert.equal(enEncouraging.pitch, '+3Hz');

    // 4. Troubleshooting / Direct
    const enDirect = ttsService.detectIntentAndProsody('Check the terminal error code and run git status.', 'en');
    assert.equal(enDirect.intent, 'direct_concise');
    assert.equal(enDirect.rate, '+5%');

    // 5. Default lively companion
    const enLively = ttsService.detectIntentAndProsody('All systems are ready, ready when you are.', 'en');
    assert.equal(enLively.intent, 'lively');
  });

  it('9. Allows custom Telugu voice configuration and manual voice overrides', () => {
    const service = new TtsService('en-GB-RyanNeural', 'te-IN-ShrutiNeural');
    assert.equal(service.teluguVoiceName, 'te-IN-ShrutiNeural');

    const teluguText = 'నమస్కారం, నేను అట్లాస్.';
    assert.equal(service.getVoiceForText(teluguText), 'te-IN-ShrutiNeural');

    // Manual override
    assert.equal(service.getVoiceForText(teluguText, 'te-IN-CustomNeural'), 'te-IN-CustomNeural');
  });
});
