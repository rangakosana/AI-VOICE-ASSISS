/**
 * Web Audio Recorder for ATLAS.
 *
 * Implements:
 * 1. 16kHz 16-bit Mono PCM downsampling and streaming for Gemini/Fastify gateway.
 * 2. Adaptive Background Noise Floor Calibration (measures ambient noise in first 300ms
 *    and dynamically sets the speech threshold above classroom/room chatter).
 * 3. Maximum Utterance Cap (10–12 seconds auto-commit protection so audio turns never hang indefinitely).
 * 4. Sustained High-Threshold Barge-In Detection (requires >=300ms of loud close-mic speech
 *    so distant background speakers don't interrupt Atlas).
 */

export interface AudioRecorderCallbacks {
  onChunk: (pcmBytes: ArrayBuffer) => void;
  onRms?: (rms: number, isSpeechAboveNoise: boolean) => void;
  onSilenceTimeout?: () => void;
  onMaxUtteranceTimeout?: () => void;
  onBargeIn?: () => void;
}

export class WebAudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private isRecordingInternal = false;

  // Adaptive noise floor calibration
  private noiseCalibrationSamples: number[] = [];
  private readonly calibrationDurationMs = 300;
  private noiseFloor = 0.02;
  private dynamicSpeechThreshold = 0.06;
  private isCalibrated = false;

  // Turn timing & VAD tracking
  private startTimestamp = 0;
  private lastSpeechTimestamp = 0;
  private hasUserSpoken = false;
  private readonly silenceTimeoutMs = 2500; // 2.5s forgiving thinking pause after speech
  private readonly maxUtteranceCapMs = 30000; // 30s max turn duration window
  private hasTriggeredTimeout = false;

  // Sustained barge-in tracking
  private isAssistantSpeaking = false;
  private bargeInStartTimestamp = 0;
  private readonly bargeInSustainedMs = 300; // 300ms of sustained loud speech required
  private readonly bargeInBaseThreshold = 0.18; // Close-mic speech energy threshold

  private callbacks: AudioRecorderCallbacks | null = null;

  get isRecording(): boolean {
    return this.isRecordingInternal;
  }

  get currentNoiseFloor(): number {
    return this.noiseFloor;
  }

  get currentSpeechThreshold(): number {
    return this.dynamicSpeechThreshold;
  }

  getAudioData(): Uint8Array {
    if (!this.analyserNode || !this.isRecordingInternal) return new Uint8Array(0);
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  }

  setAssistantSpeaking(speaking: boolean): void {
    this.isAssistantSpeaking = speaking;
    if (!speaking) {
      this.bargeInStartTimestamp = 0;
    }
  }

  async start(
    callbacksOrChunk: AudioRecorderCallbacks | ((pcmBytes: ArrayBuffer) => void),
    legacyOnRms?: (rms: number) => void
  ): Promise<boolean> {
    if (this.isRecordingInternal) return true;

    if (typeof callbacksOrChunk === 'function') {
      this.callbacks = {
        onChunk: callbacksOrChunk,
        onRms: legacyOnRms ? (rms: number) => legacyOnRms(rms) : undefined,
      };
    } else {
      this.callbacks = callbacksOrChunk;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Target 16kHz sample rate standard
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 16000 });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Real-time frequency analyser for holographic HUD visualizer
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;
      this.sourceNode.connect(this.analyserNode);

      // ScriptProcessor with 2048 buffer size (~128ms frames at 16kHz)
      this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);

      // Reset state and begin calibration
      this.startTimestamp = Date.now();
      this.lastSpeechTimestamp = this.startTimestamp;
      this.hasUserSpoken = false;
      this.hasTriggeredTimeout = false;
      this.isCalibrated = false;
      this.noiseCalibrationSamples = [];
      this.bargeInStartTimestamp = 0;

      this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.isRecordingInternal) return;

        const inputChannelData = event.inputBuffer.getChannelData(0);
        const pcm16Buffer = this.floatTo16BitPCM(inputChannelData);
        const rawRms = this.calculateRawRms(inputChannelData);
        const now = Date.now();

        // 1. First 300ms: Measure ambient background noise floor
        if (!this.isCalibrated) {
          this.noiseCalibrationSamples.push(rawRms);
          if (now - this.startTimestamp >= this.calibrationDurationMs) {
            const sum = this.noiseCalibrationSamples.reduce((a, b) => a + b, 0);
            this.noiseFloor = sum / Math.max(1, this.noiseCalibrationSamples.length);
            // Dynamically place speech threshold safely above the room noise floor
            this.dynamicSpeechThreshold = Math.max(
              0.045,
              Math.min(0.22, this.noiseFloor * 2.2 + 0.03)
            );
            this.isCalibrated = true;
          }
        }

        // 2. Classify speech vs background noise
        const isSpeechAboveNoise = this.isCalibrated && rawRms > this.dynamicSpeechThreshold;

        if (isSpeechAboveNoise) {
          this.hasUserSpoken = true;
          this.lastSpeechTimestamp = now;
        }

        // 3. VAD Silence Timeout check (1.8s of silence after speech was detected)
        if (
          !this.hasTriggeredTimeout &&
          this.hasUserSpoken &&
          now - this.lastSpeechTimestamp > this.silenceTimeoutMs
        ) {
          this.hasTriggeredTimeout = true;
          this.callbacks?.onSilenceTimeout?.();
        }

        // 4. Maximum Utterance Cap (11 seconds)
        if (!this.hasTriggeredTimeout && now - this.startTimestamp >= this.maxUtteranceCapMs) {
          this.hasTriggeredTimeout = true;
          this.callbacks?.onMaxUtteranceTimeout?.();
        }

        // 5. Sustained High-Threshold Barge-In check while Assistant is speaking
        if (this.isAssistantSpeaking) {
          const closeMicThreshold = Math.max(this.bargeInBaseThreshold, this.noiseFloor * 3.0);
          if (rawRms >= closeMicThreshold) {
            if (this.bargeInStartTimestamp === 0) {
              this.bargeInStartTimestamp = now;
            } else if (now - this.bargeInStartTimestamp >= this.bargeInSustainedMs) {
              // Sustained loud, close-mic speech confirmed: trigger barge-in
              this.bargeInStartTimestamp = 0;
              this.callbacks?.onBargeIn?.();
            }
          } else {
            this.bargeInStartTimestamp = 0;
          }
        }

        // 6. Visual RMS amplification for UI visualizer
        const visualRms = Math.min(1.0, rawRms * 4.0);
        this.callbacks?.onRms?.(visualRms, isSpeechAboveNoise);

        // 7. Emit raw binary 16-bit PCM chunk over WebSocket
        this.callbacks?.onChunk(pcm16Buffer);
      };

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      this.isRecordingInternal = true;
      return true;
    } catch (err) {
      console.error('Failed to start microphone capture:', err);
      this.stop();
      return false;
    }
  }

  stop(): void {
    this.isRecordingInternal = false;
    this.hasTriggeredTimeout = false;
    this.bargeInStartTimestamp = 0;

    if (this.processorNode && this.sourceNode) {
      try {
        this.sourceNode.disconnect();
        this.processorNode.disconnect();
        this.analyserNode?.disconnect();
      } catch (_) {}
    }
    this.analyserNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (_) {}
      this.audioContext = null;
    }

    this.callbacks?.onRms?.(0, false);
  }

  private floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      // Convert float [-1.0, 1.0] to 16-bit signed integer [-32768, 32767]
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  private calculateRawRms(float32Array: Float32Array): number {
    if (float32Array.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) {
      sum += float32Array[i] * float32Array[i];
    }
    return Math.sqrt(sum / float32Array.length);
  }
}
