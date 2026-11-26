/**
 * J.A.R.V.I.S.-style Futuristic Web Audio Feedback Chimes.
 *
 * Generates lightweight, synthesized audio cues directly using Web Audio API oscillators:
 * - Wake Word detection ("Hey Atlas")
 * - Mic activation
 * - Barge-in cancellation
 * - System connection
 *
 * Includes local storage mute persistence and graceful gain ramping to prevent clipping.
 */

export class HudSoundEffects {
  private audioCtx: AudioContext | null = null;
  private muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('atlas_hud_sfx_muted') === 'true';
    } catch (_) {}
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem('atlas_hud_sfx_muted', String(this.muted));
    } catch (_) {}
    return this.muted;
  }

  private getContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;

    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    return this.audioCtx;
  }

  /**
   * Two-tone rising harmonic chime when "Hey Atlas" is detected (D5 -> A5).
   */
  playWakeChime(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.12); // A5

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.29);
  }

  /**
   * Crisp futuristic activation blip when voice capture starts.
   */
  playMicActiveChime(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(440.0, now);
    osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.08); // E5

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.15);
  }

  /**
   * Cyber downward cancellation chirp when barge-in interrupt is triggered.
   */
  playInterruptChime(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, now); // C5
    osc.frequency.exponentialRampToValueAtTime(261.63, now + 0.09); // C4

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.16);
  }

  /**
   * Warm affirmative system online chirp on WebSocket connection ready.
   */
  playConnectChime(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const freqs = [523.25, 659.25, 783.99]; // C5, E5, G5 triad
    freqs.forEach((freq, idx) => {
      const start = now + idx * 0.05;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + 0.19);
    });
  }
}
