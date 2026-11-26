/**
 * Full-Screen Three.js Canvas with:
 * 1. True Full-Viewport Ambient Twinkling Cosmic Starfield:
 *    - 850 stars distributed across the entire screen frustum edge-to-edge.
 *    - Dual-tier glowing particle layers:
 *      * 600 fine pinpoint stars (3.5px) with soft twinkling
 *      * 250 medium/hero stars (6.0px) with rich multi-color glow (ice white, cyan, violet, gold)
 *    - Bright twinkling opacity waves (0.35 to 1.0).
 *    - Slow cosmic drift and gentle mouse parallax across the dark viewport.
 * 2. High-Energy Bioluminescent 3D Particle Sphere:
 *    - Centered precisely in the upper-center stage (matching .hud-visualizer-container).
 *    - Exact size and hovering/breathing behavior preserved.
 *    - Dynamic multi-color spectrum (electric cyan #00E5FF, vibrant violet #A855F7,
 *      warm gold/amber #F59E0B, and emerald #10B981) shifting with assistant state
 *      (Ready, Listening, Thinking, Speaking) and pulsing to voice/TTS audio.
 * 3. Tilted Celestial Orbital Ring & Dense Inner Core Nucleus.
 */

import * as THREE from 'three';
import type { AssistantState } from './types.js';

export interface HudVisualizerState {
  assistantState: AssistantState;
  isRecording: boolean;
  audioRms: number;
  frequencyData: Uint8Array;
}

interface StarData {
  baseX: number;
  baseY: number;
  baseZ: number;
  vx: number;
  vy: number;
  twinkleSpeed: number;
  twinklePhase: number;
  color: THREE.Color;
}

export class HudArcReactorVisualizer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  // Groups
  private sphereGroup: THREE.Group;
  private starsGroup: THREE.Group;

  // Outer Sphere Particle System
  private outerGeometry: THREE.BufferGeometry;
  private outerMaterial: THREE.PointsMaterial;
  private outerBaseDirections: Float32Array;
  private outerCount = 2800;
  private baseRadius = 78;

  // Inner Core Particle System
  private innerGeometry: THREE.BufferGeometry;
  private innerMaterial: THREE.PointsMaterial;
  private innerBaseDirections: Float32Array;
  private innerBaseRadii: Float32Array;
  private innerCount = 1200;

  // Orbital Ring System
  private ringMaterial: THREE.PointsMaterial;
  private ringPoints: THREE.Points;
  private ringCount = 600;

  // Ambient Twinkling Starfield System (850 total stars: 600 small, 250 large)
  private smallStarGeometry: THREE.BufferGeometry;
  private largeStarGeometry: THREE.BufferGeometry;
  private smallStarData: StarData[] = [];
  private largeStarData: StarData[] = [];
  private readonly smallStarCount = 600;
  private readonly largeStarCount = 250;

  // Frustum bounds for edge-to-edge starfield wrapping
  private starFrustumHalfW = 600;
  private starFrustumHalfH = 400;

  // Telemetry & Clocks
  private time = 0;
  private breathingPhase = 0;
  private smoothedRms = 0;
  private smoothedBass = 0;
  private smoothedMids = 0;

  // Mouse Parallax
  private targetMouseX = 0;
  private targetMouseY = 0;
  private mouseX = 0;
  private mouseY = 0;

  // Multi-Color Palette Definitions
  private readonly palette = {
    cyan: new THREE.Color('#00E5FF'),
    violet: new THREE.Color('#A855F7'),
    amber: new THREE.Color('#F59E0B'),
    gold: new THREE.Color('#FBBF24'),
    emerald: new THREE.Color('#10B981'),
    white: new THREE.Color('#FFFFFF'),
  };

  // State-driven color blend targets
  private colorPhase = 0;

  constructor(canvas: HTMLCanvasElement) {
    // 1. Initialize Scene, Camera & WebGLRenderer
    this.scene = new THREE.Scene();

    const width = window.innerWidth || 1200;
    const height = window.innerHeight || 800;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    this.camera.position.z = 210 * (Math.max(height, 600) / 360);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // Groups
    this.starsGroup = new THREE.Group();
    this.sphereGroup = new THREE.Group();
    this.scene.add(this.starsGroup);
    this.scene.add(this.sphereGroup);

    // 2. Generate Glowing Particle Sprite Textures
    const sphereParticleTexture = this.createGlowParticleTexture();
    const starGlowTexture = this.createStarGlowTexture();

    // 3. Build Outer Sphere (Fibonacci distribution with multi-color palette)
    const { geometry: outerGeo, directions: outerDirs } = this.buildOuterSphere();
    this.outerGeometry = outerGeo;
    this.outerBaseDirections = outerDirs;
    this.outerMaterial = new THREE.PointsMaterial({
      size: 4.8,
      map: sphereParticleTexture,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const outerPoints = new THREE.Points(this.outerGeometry, this.outerMaterial);
    this.sphereGroup.add(outerPoints);

    // 4. Build Dense Inner Core Nucleus
    const { geometry: innerGeo, directions: innerDirs, radii: innerR } = this.buildInnerCore();
    this.innerGeometry = innerGeo;
    this.innerBaseDirections = innerDirs;
    this.innerBaseRadii = innerR;
    this.innerMaterial = new THREE.PointsMaterial({
      size: 5.2,
      map: sphereParticleTexture,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const innerPoints = new THREE.Points(this.innerGeometry, this.innerMaterial);
    this.sphereGroup.add(innerPoints);

    // 5. Build Tilted Orbital Celestial Ring
    const ringGeometry = this.buildOrbitalRing();
    this.ringMaterial = new THREE.PointsMaterial({
      size: 3.4,
      map: sphereParticleTexture,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ringPoints = new THREE.Points(ringGeometry, this.ringMaterial);
    this.ringPoints.rotation.x = Math.PI * 0.28;
    this.ringPoints.rotation.y = Math.PI * 0.12;
    this.sphereGroup.add(this.ringPoints);

    // 6. Build Ambient Starfield Background (Edge-to-Edge)
    this.updateFrustumBounds(width, height);

    const smallStarRes = this.buildStarLayer(
      this.smallStarCount,
      3.5,
      starGlowTexture,
      this.smallStarData
    );
    this.smallStarGeometry = smallStarRes.geometry;

    const largeStarRes = this.buildStarLayer(
      this.largeStarCount,
      6.0,
      starGlowTexture,
      this.largeStarData
    );
    this.largeStarGeometry = largeStarRes.geometry;

    // 7. Setup Mouse Parallax Tracking
    window.addEventListener('mousemove', (e) => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      this.targetMouseX = (e.clientX / w - 0.5) * 2;
      this.targetMouseY = (e.clientY / h - 0.5) * 2;
    });

    // 8. Position Sphere Group in Upper-Center Stage
    this.alignSphereToStage();
  }

  private createGlowParticleTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.2, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(0.48, 'rgba(0, 229, 255, 0.6)');
    grad.addColorStop(0.8, 'rgba(168, 85, 247, 0.18)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createStarGlowTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.18, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(0.42, 'rgba(0, 229, 255, 0.7)');
    grad.addColorStop(0.72, 'rgba(168, 85, 247, 0.3)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private buildOuterSphere(): { geometry: THREE.BufferGeometry; directions: Float32Array } {
    const count = this.outerCount;
    const positions = new Float32Array(count * 3);
    const directions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    const phi = Math.PI * (Math.sqrt(5) - 1);

    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = phi * i;

      const ux = Math.cos(theta) * radiusAtY;
      const uy = y;
      const uz = Math.sin(theta) * radiusAtY;

      directions[i * 3] = ux;
      directions[i * 3 + 1] = uy;
      directions[i * 3 + 2] = uz;

      positions[i * 3] = ux * this.baseRadius;
      positions[i * 3 + 1] = uy * this.baseRadius;
      positions[i * 3 + 2] = uz * this.baseRadius;

      const c = this.getSpectrumColor(i, count, 'IDLE', 0);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return { geometry, directions };
  }

  private buildInnerCore(): {
    geometry: THREE.BufferGeometry;
    directions: Float32Array;
    radii: Float32Array;
  } {
    const count = this.innerCount;
    const positions = new Float32Array(count * 3);
    const directions = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const sinPhi = Math.sin(phi);

      const ux = sinPhi * Math.cos(theta);
      const uy = sinPhi * Math.sin(theta);
      const uz = Math.cos(phi);

      directions[i * 3] = ux;
      directions[i * 3 + 1] = uy;
      directions[i * 3 + 2] = uz;

      const r = 24 + Math.random() * 20;
      radii[i] = r;

      positions[i * 3] = ux * r;
      positions[i * 3 + 1] = uy * r;
      positions[i * 3 + 2] = uz * r;

      const rand = Math.random();
      let c = this.palette.amber;
      if (rand > 0.8) c = this.palette.white;
      else if (rand > 0.55) c = this.palette.gold;
      else if (rand > 0.3) c = this.palette.violet;
      else c = this.palette.cyan;

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return { geometry, directions, radii };
  }

  private buildOrbitalRing(): THREE.BufferGeometry {
    const count = this.ringCount;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const r = 105 + Math.random() * 28;
      const yScatter = (Math.random() - 0.5) * 8;

      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = yScatter;
      positions[i * 3 + 2] = Math.sin(angle) * r;

      const rand = Math.random();
      let c = this.palette.cyan;
      if (rand > 0.7) c = this.palette.violet;
      else if (rand > 0.4) c = this.palette.gold;

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return geometry;
  }

  private updateFrustumBounds(width: number, height: number): void {
    const aspect = width / height;
    const fovRad = (45 * Math.PI) / 360;
    // Bounds at star depth (Z = -100)
    const dist = this.camera.position.z + 100;
    this.starFrustumHalfH = Math.tan(fovRad) * dist * 1.15;
    this.starFrustumHalfW = this.starFrustumHalfH * aspect * 1.15;
  }

  private buildStarLayer(
    count: number,
    pointPixelSize: number,
    texture: THREE.Texture,
    starStore: StarData[]
  ): { geometry: THREE.BufferGeometry } {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    const tintOptions = [
      new THREE.Color('#FFFFFF'), // Ice White
      new THREE.Color('#00E5FF'), // Electric Cyan
      new THREE.Color('#A855F7'), // Soft Violet
      new THREE.Color('#FBBF24'), // Warm Gold
      new THREE.Color('#38BDF8'), // Azure
    ];

    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * this.starFrustumHalfW;
      const y = (Math.random() * 2 - 1) * this.starFrustumHalfH;
      const z = -120 + Math.random() * 80;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const tint = tintOptions[Math.floor(Math.random() * tintOptions.length)];

      starStore.push({
        baseX: x,
        baseY: y,
        baseZ: z,
        vx: (Math.random() - 0.5) * 0.09,
        vy: (Math.random() - 0.5) * 0.09,
        twinkleSpeed: 1.4 + Math.random() * 3.2,
        twinklePhase: Math.random() * Math.PI * 2,
        color: tint.clone(),
      });

      colors[i * 3] = tint.r * 0.7;
      colors[i * 3 + 1] = tint.g * 0.7;
      colors[i * 3 + 2] = tint.b * 0.7;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: pointPixelSize,
      sizeAttenuation: false, // Guarantees crisp glowing points in exact screen pixels
      map: texture,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    this.starsGroup.add(points);

    return { geometry };
  }

  private getSpectrumColor(
    index: number,
    total: number,
    state: AssistantState,
    audioEnergy: number
  ): THREE.Color {
    const norm = index / total;
    const wave = Math.sin(norm * Math.PI * 6 + this.colorPhase);

    if (Math.random() < 0.08 + audioEnergy * 0.12) {
      return this.palette.white;
    }

    switch (state) {
      case 'LISTENING':
        if (wave > 0.4) return this.palette.emerald;
        if (wave > -0.2) return this.palette.cyan;
        return this.palette.gold;

      case 'THINKING':
        if (wave > 0.3) return this.palette.violet;
        if (wave > -0.3) return this.palette.amber;
        return this.palette.gold;

      case 'SPEAKING':
        if (wave > 0.5) return this.palette.cyan;
        if (wave > 0.0) return this.palette.violet;
        if (wave > -0.5) return this.palette.gold;
        return this.palette.emerald;

      case 'IDLE':
      default:
        if (wave > 0.35) return this.palette.cyan;
        if (wave > -0.2) return this.palette.violet;
        return this.palette.gold;
    }
  }

  private alignSphereToStage(): void {
    const height = window.innerHeight || 800;
    const container = document.querySelector('.hud-visualizer-container');

    let targetPixelY = height * 0.28;
    if (container) {
      const rect = container.getBoundingClientRect();
      targetPixelY = rect.top + rect.height * 0.48;
    }

    const deltaYPixels = height / 2 - targetPixelY;
    const worldUnitsPerPixel = (2 * Math.tan((45 * Math.PI) / 360) * this.camera.position.z) / height;

    this.sphereGroup.position.y = deltaYPixels * worldUnitsPerPixel;
    this.sphereGroup.position.x = 0;
  }

  resize(): void {
    const width = window.innerWidth || 1200;
    const height = window.innerHeight || 800;

    this.camera.aspect = width / height;
    this.camera.position.z = 210 * (Math.max(height, 600) / 360);
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.updateFrustumBounds(width, height);
    this.alignSphereToStage();
  }

  render(state: HudVisualizerState): void {
    // 1. Process Audio Frequency Bins
    let rawBass = 0;
    let rawMids = 0;
    const freqLen = state.frequencyData ? state.frequencyData.length : 0;

    if (freqLen > 0) {
      const bassCount = Math.min(8, freqLen);
      let bSum = 0;
      for (let i = 0; i < bassCount; i++) bSum += state.frequencyData[i];
      rawBass = bSum / (bassCount * 255);

      const midCount = Math.min(32, freqLen) - bassCount;
      if (midCount > 0) {
        let mSum = 0;
        for (let i = bassCount; i < bassCount + midCount; i++) mSum += state.frequencyData[i];
        rawMids = mSum / (midCount * 255);
      }
    }

    this.smoothedRms += (state.audioRms - this.smoothedRms) * 0.22;
    this.smoothedBass += (rawBass - this.smoothedBass) * 0.25;
    this.smoothedMids += (rawMids - this.smoothedMids) * 0.25;

    const audioEnergy = Math.max(
      this.smoothedRms,
      this.smoothedBass * 0.8 + this.smoothedMids * 0.4
    );

    // 2. Clocks & State Speeds
    let speedMult = 1.0;
    switch (state.assistantState) {
      case 'THINKING':
        speedMult = 2.5;
        break;
      case 'SPEAKING':
        speedMult = 1.6 + audioEnergy * 2.4;
        break;
      case 'LISTENING':
        speedMult = 1.3 + audioEnergy * 2.2;
        break;
      case 'IDLE':
      default:
        speedMult = 0.85;
        break;
    }

    this.time += 0.018 * speedMult;
    this.colorPhase += 0.024 * speedMult;
    this.breathingPhase += 0.028;

    const breathScale = 1.0 + Math.sin(this.breathingPhase) * 0.035;

    // 3. Smooth Mouse Parallax Interpolation
    this.mouseX += (this.targetMouseX - this.mouseX) * 0.05;
    this.mouseY += (this.targetMouseY - this.mouseY) * 0.05;

    // Starfield parallax
    this.starsGroup.position.x = -this.mouseX * 30;
    this.starsGroup.position.y = this.mouseY * 20;

    // Subtle sphere group tilt
    this.sphereGroup.rotation.y += 0.007 * speedMult;
    this.sphereGroup.rotation.x = Math.sin(this.time * 0.4) * 0.12 + this.mouseY * 0.14;
    this.sphereGroup.rotation.z = -this.mouseX * 0.12;

    // 4. Update Ambient Starfield Twinkling (0.35 to 1.0 opacity waves) & Full-Screen Drift
    this.updateStars(this.smallStarGeometry, this.smallStarData);
    this.updateStars(this.largeStarGeometry, this.largeStarData);

    // 5. Audio-Reactive 3D Deformation of Outer Sphere Particles
    const outPos = this.outerGeometry.attributes.position.array as Float32Array;
    const outDirs = this.outerBaseDirections;
    const outCol = this.outerGeometry.attributes.color.array as Float32Array;
    const count = this.outerCount;

    const audioExpansion = audioEnergy * 44;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const ux = outDirs[idx];
      const uy = outDirs[idx + 1];
      const uz = outDirs[idx + 2];

      const wave1 = Math.sin(ux * 4.2 + this.time * 3.2) * Math.cos(uy * 4.2 + this.time * 2.8);
      const wave2 = Math.cos(uz * 7.5 - this.time * 2.5) * Math.sin(ux * 7.5 + this.time * 2.0);
      const wave3 = Math.sin(uy * 11.0 + this.time * 4.0) * 0.4;

      const ripple = (wave1 * 0.65 + wave2 * 0.35 + wave3) * (6 + audioEnergy * 32);
      const r = (this.baseRadius + audioExpansion + ripple) * breathScale;

      outPos[idx] = ux * r;
      outPos[idx + 1] = uy * r;
      outPos[idx + 2] = uz * r;

      const c = this.getSpectrumColor(i, count, state.assistantState, audioEnergy);
      outCol[idx] = c.r;
      outCol[idx + 1] = c.g;
      outCol[idx + 2] = c.b;
    }
    this.outerGeometry.attributes.position.needsUpdate = true;
    this.outerGeometry.attributes.color.needsUpdate = true;

    // 6. Inner Core Audio Pulse
    const inPos = this.innerGeometry.attributes.position.array as Float32Array;
    const inDirs = this.innerBaseDirections;
    const inRadii = this.innerBaseRadii;
    const inCount = this.innerCount;
    const corePulse = 1.0 + audioEnergy * 0.45;

    for (let i = 0; i < inCount; i++) {
      const idx = i * 3;
      const ux = inDirs[idx];
      const uy = inDirs[idx + 1];
      const uz = inDirs[idx + 2];
      const r = inRadii[i] * corePulse * breathScale;

      inPos[idx] = ux * r;
      inPos[idx + 1] = uy * r;
      inPos[idx + 2] = uz * r;
    }
    this.innerGeometry.attributes.position.needsUpdate = true;

    // 7. Dynamic Material Size & Luminous Pulse
    this.outerMaterial.size = 4.6 + audioEnergy * 5.2;
    this.innerMaterial.size = 5.0 + audioEnergy * 6.5;
    this.ringMaterial.size = 3.2 + audioEnergy * 3.0;

    this.ringPoints.rotation.z += 0.004 * speedMult;

    // 8. Render Frame
    this.renderer.render(this.scene, this.camera);
  }

  private updateStars(geometry: THREE.BufferGeometry, stars: StarData[]): void {
    const pos = geometry.attributes.position.array as Float32Array;
    const col = geometry.attributes.color.array as Float32Array;
    const len = stars.length;
    const halfW = this.starFrustumHalfW;
    const halfH = this.starFrustumHalfH;

    for (let i = 0; i < len; i++) {
      const s = stars[i];

      // Slow cosmic drift
      s.baseX += s.vx;
      s.baseY += s.vy;
      if (s.baseX > halfW) s.baseX = -halfW;
      if (s.baseX < -halfW) s.baseX = halfW;
      if (s.baseY > halfH) s.baseY = -halfH;
      if (s.baseY < -halfH) s.baseY = halfH;

      pos[i * 3] = s.baseX;
      pos[i * 3 + 1] = s.baseY;

      // Bright twinkling opacity waves (0.35 to 1.0)
      const twinkle = Math.sin(this.time * s.twinkleSpeed + s.twinklePhase) * 0.5 + 0.5;
      const brightness = 0.35 + twinkle * 0.65;

      col[i * 3] = s.color.r * brightness;
      col[i * 3 + 1] = s.color.g * brightness;
      col[i * 3 + 2] = s.color.b * brightness;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  }
}
