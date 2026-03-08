import { Renderer, Camera } from './renderer';
import { createCornellBox, SceneData } from './scene/geometry';
import { CameraController } from './camera';
import { WadParser } from './doom/wad-parser';
import { convertLevelToScene, setTextureAtlas } from './doom/level-converter';
import { CollisionDetector } from './doom/collision';
import { TextureExtractor, TextureAtlas } from './doom/textures';
import { createDungeonScene, TILE_SIZE } from './scene/dungeon';
import { DungeonCameraController } from './scene/dungeon-camera';
import { createPhantomMaterials, createPhantomTrianglesAt } from './scene/phantom';
import { getDungeonMap } from './scene/dungeon';
import { createBVHTeachingScene } from './scene/bvh-teaching';

// Capture script base URL at load time for resolving relative asset paths.
// Works for both IIFE (<script src="...">) and ES module builds.
const SCRIPT_BASE_URL = (() => {
  // ES module
  try { return new URL('.', import.meta.url).href; } catch {}
  // IIFE / classic script
  if (document.currentScript instanceof HTMLScriptElement) {
    return new URL('.', document.currentScript.src).href;
  }
  return '';
})();

type ActiveScene = 'doom' | 'dungeon' | 'bvh';

const DEFAULTS = {
  scene: 'doom' as ActiveScene,
  samples: 4,
  bounces: 3,
  resolution: 1.0,
  temporal: 1,
  denoise: 'atrous',
  'denoise-passes': 1,
  'debug-mode': 0,
  'debug-opacity': 100,
  'debug-window': true,
  'debug-depth': 3,
  'player-light': 17,
  'player-falloff': 17,
  'render-distance': 10,
  phantom: true,
  width: 1280,
  height: 800,
};

const DENOISE_MODE_MAP: Record<string, number> = { off: 0, median: 1, adaptive: 2, atrous: 3 };
const DEBUG_MODE_MAP: Record<string, number> = { off: 0, traversal: 1, depth: 2, leaf: 3, wireframe: 4 };
const DEBUG_MODE_NAMES = ['off', 'traversal', 'depth', 'leaf', 'wireframe'];

const STYLES = `
  :host {
    display: block;
    position: relative;
    background: #000;
    font-family: system-ui, sans-serif;
  }
  canvas {
    display: block;
    max-width: 100%;
    max-height: 100vh;
  }
  #error {
    color: #ff6b6b;
    padding: 2rem;
    text-align: center;
    display: none;
  }
  #hint {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.875rem;
    pointer-events: none;
    transition: opacity 0.3s;
  }
  #hint.hidden { opacity: 0; }
  #controls {
    position: absolute;
    top: 1rem;
    right: 1rem;
    background: rgba(0, 0, 0, 0.8);
    padding: 1rem;
    border-radius: 8px;
    color: white;
    font-size: 0.875rem;
    min-width: 220px;
  }
  #controls label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  #controls input[type="range"] { width: 80px; }
  #controls input[type="checkbox"] { width: 18px; height: 18px; }
  #controls .value {
    min-width: 45px;
    text-align: right;
    font-family: monospace;
  }
  #controls select {
    background: #333;
    color: white;
    border: none;
    padding: 4px 8px;
    border-radius: 4px;
  }
  #stats {
    font-family: monospace;
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    line-height: 1.4;
  }
  #stats .stat-row {
    display: flex;
    justify-content: space-between;
  }
  #stats .stat-value { color: #8f8; }
  #container.paused canvas {
    filter: brightness(0.4);
    transition: filter 0.3s;
  }
  #container.paused #controls {
    opacity: 0.3;
    pointer-events: none;
    transition: opacity 0.3s;
  }
  #controls.hidden, #hint.hidden { display: none; }
  #play-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: none;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    z-index: 10;
  }
  #play-overlay.visible { display: flex; }
  #play-btn {
    width: 80px;
    height: 80px;
    background: #000;
    border-radius: 50%;
    display: flex;
    justify-content: center;
    align-items: center;
    transition: transform 0.15s;
  }
  #play-btn:hover { transform: scale(1.1); }
  #play-btn svg {
    width: 36px;
    height: 36px;
    margin-left: 4px;
  }
`;

const CONTROLS_HTML = `
  <div id="stats">
    <div class="stat-row"><span>FPS:</span> <span class="stat-value" id="fps-value">--</span></div>
    <div class="stat-row"><span>Rays/sec:</span> <span class="stat-value" id="rays-value">--</span></div>
    <div class="stat-row"><span>Samples:</span> <span class="stat-value" id="samples-display">--</span></div>
    <div class="stat-row"><span>Resolution:</span> <span class="stat-value" id="res-display">--</span></div>
  </div>
  <label>
    <span>Scene</span>
    <select id="scene-select">
      <option value="doom">Doom E1M1</option>
      <option value="dungeon">Dungeon</option>
      <option value="bvh">BVH Teaching</option>
    </select>
  </label>
  <label>
    <span>Samples/pixel</span>
    <input type="range" id="samples" min="1" max="64" value="4" step="1">
    <span class="value" id="samples-value">4</span>
  </label>
  <label>
    <span>Max bounces</span>
    <input type="range" id="bounces" min="1" max="10" value="3">
    <span class="value" id="bounces-value">3</span>
  </label>
  <label>
    <span>Resolution</span>
    <select id="resolution">
      <option value="0.25">0.25x</option>
      <option value="0.5">0.5x</option>
      <option value="0.75">0.75x</option>
      <option value="1.0">1.0x</option>
      <option value="2.0">2.0x</option>
    </select>
  </label>
  <label>
    <span>Temporal</span>
    <input type="range" id="temporal" min="0" max="5" value="1" step="1">
    <span class="value" id="temporal-value">1</span>
  </label>
  <label>
    <span>Denoise</span>
    <select id="denoise-mode">
      <option value="off">Off</option>
      <option value="median">Median</option>
      <option value="adaptive">Adaptive</option>
      <option value="atrous">À-trous</option>
    </select>
  </label>
  <label id="denoise-passes-label">
    <span>Denoise passes</span>
    <input type="range" id="denoise" min="1" max="5" value="1" step="1">
    <span class="value" id="denoise-value">1</span>
  </label>
  <label>
    <span>Debug BVH</span>
    <select id="debug-mode">
      <option value="0">Off</option>
      <option value="1">Traversal</option>
      <option value="2">Depth</option>
      <option value="3">Leaf count</option>
      <option value="4">Wireframe</option>
    </select>
  </label>
  <label id="debug-opacity-label" style="display: none;">
    <span>Debug opacity</span>
    <input type="range" id="debug-opacity" min="0" max="100" value="100" step="5">
    <span class="value" id="debug-opacity-value">100%</span>
  </label>
  <label id="debug-window-label" style="display: none;">
    <span>Window mode</span>
    <input type="checkbox" id="debug-window" checked>
  </label>
  <label id="debug-depth-label" style="display: none;">
    <span>BVH depth</span>
    <input type="range" id="debug-depth" min="0" max="20" value="3" step="1">
    <span class="value" id="debug-depth-value">3</span>
  </label>
  <label id="player-light-label" style="display: none;">
    <span>Player torch</span>
    <input type="range" id="player-light" min="0" max="20" value="17" step="1">
    <span class="value" id="player-light-value">17</span>
  </label>
  <label id="player-falloff-label" style="display: none;">
    <span>Torch size</span>
    <input type="range" id="player-falloff" min="1" max="20" value="17" step="1">
    <span class="value" id="player-falloff-value">17</span>
  </label>
  <label id="render-dist-label" style="display: none;">
    <span>View distance</span>
    <input type="range" id="render-dist" min="2" max="10" value="10" step="1">
    <span class="value" id="render-dist-value">10</span>
  </label>
  <label id="phantom-label" style="display: none;">
    <span>Phantom</span>
    <input type="checkbox" id="phantom" checked>
  </label>
`;

export class PathTracerElement extends HTMLElement {
  static observedAttributes = [
    'scene', 'samples', 'bounces', 'resolution', 'temporal',
    'denoise', 'denoise-passes', 'debug-mode', 'debug-opacity',
    'debug-window', 'debug-depth', 'player-light', 'player-falloff',
    'render-distance', 'phantom', 'width', 'height', 'controls',
  ];

  private shadow: ShadowRoot;
  private canvas!: HTMLCanvasElement;
  private initialized = false;
  private animFrameId = 0;
  private paused = false;
  private userPaused = false; // true until user clicks play
  private scrollPaused = false;
  private warmupFrames = 0;
  private static readonly WARMUP_COUNT = 3;
  private intersectionObserver: IntersectionObserver | null = null;
  private pendingScreenshot = false;

  // WebGPU
  private device!: GPUDevice;
  private gpuContext!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private renderer!: Renderer;

  // Scenes
  private doomScene!: SceneData;
  private doomTextureAtlas: TextureAtlas | null = null;
  private doomCameraController!: CameraController;
  private dungeonScene!: SceneData;
  private dungeonTextureAtlas: TextureAtlas | null = null;
  private dungeonCameraController!: DungeonCameraController;
  private bvhScene!: SceneData;
  private bvhCameraController!: CameraController;

  // Active state
  private activeScene: ActiveScene = DEFAULTS.scene;
  private currentCamera!: { update(dt: number): void; getCamera(): Camera; attach(c: HTMLCanvasElement, t?: EventTarget): void; detach?(): void };

  // Phantom animation state
  private dungeonMap!: number[][];
  private phantomMats!: { body: number; head: number; eye: number };
  private phantomX = 0;
  private phantomZ = 0;
  private phantomDirZ = 1;
  private phantomSpeed = 1.0;
  private phantomTriangles: any[] = [];

  // Performance tracking
  private lastTime = 0;
  private frameCount = 0;
  private fpsAccumulator = 0;
  private lastFpsUpdate = 0;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  // --- Asset resolution ---
  private assetURL(relativePath: string): string {
    const base = this.getAttribute('asset-base') || SCRIPT_BASE_URL;
    if (!base) return relativePath;
    return new URL(relativePath, base).href;
  }

  // --- Attribute helpers ---
  private getNum(name: string, def: number): number {
    const v = this.getAttribute(name);
    if (v === null) return def;
    const n = parseFloat(v);
    return isNaN(n) ? def : n;
  }

  private getStr(name: string, def: string): string {
    return this.getAttribute(name) ?? def;
  }

  private getBool(name: string, def: boolean): boolean {
    if (!this.hasAttribute(name)) {
      // Before initialization, use the default; after, absence means false
      return this.initialized ? false : def;
    }
    const v = this.getAttribute(name);
    if (v === 'false' || v === '0') return false;
    return true;
  }

  // --- Lifecycle ---
  connectedCallback() {
    this.setAttribute('tabindex', '0');
    this.buildDOM();
    this.init().catch(err => {
      console.error('PathTracer init failed:', err);
      this.showError(String(err));
    });
  }

  disconnectedCallback() {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.intersectionObserver?.disconnect();
    this.doomCameraController?.detach();
    this.dungeonCameraController?.detach();
    this.bvhCameraController?.detach();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (!this.initialized || oldValue === newValue) return;
    this.applyAttribute(name);
  }

  // --- DOM ---
  private buildDOM() {
    const w = this.getNum('width', DEFAULTS.width);
    const h = this.getNum('height', DEFAULTS.height);
    const showControls = this.hasAttribute('controls');

    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div id="error"></div>
      <div id="container">
        <canvas width="${w}" height="${h}"></canvas>
        <div id="play-overlay">
          <div id="play-btn">
            <svg viewBox="0 0 24 24" fill="white"><polygon points="6,3 20,12 6,21"/></svg>
          </div>
        </div>
        <div id="hint">Click to capture mouse | WASD to move | Q/E to rotate | Space/Shift for up/down | ESC to release</div>
        ${showControls ? `<div id="controls">${CONTROLS_HTML}</div>` : ''}
      </div>
    `;
    this.canvas = this.shadow.querySelector('canvas')!;
  }

  private showError(msg: string) {
    const el = this.shadow.querySelector('#error') as HTMLDivElement;
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
    this.canvas.style.display = 'none';
  }

  // --- Initialization ---
  private async init() {
    if (!navigator.gpu) {
      this.showError('WebGPU is not supported in this browser.');
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      this.showError('Failed to get WebGPU adapter.');
      return;
    }
    this.device = await adapter.requestDevice();
    this.gpuContext = this.canvas.getContext('webgpu')!;
    if (!this.gpuContext) {
      this.showError('Failed to get WebGPU context.');
      return;
    }
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.gpuContext.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    // Load all scenes
    await Promise.all([this.loadDoom(), this.loadDungeon(), this.loadBVH()]);

    // Set initial scene from attribute
    this.activeScene = this.getStr('scene', DEFAULTS.scene) as ActiveScene;
    this.setActiveCamera();

    // Create renderer
    await this.createRenderer();

    // Wire controls panel if present
    if (this.hasAttribute('controls')) {
      this.wireControls();
    }

    // Wire play button
    this.shadow.getElementById('play-overlay')?.addEventListener('click', () => {
      this.warmupFrames = PathTracerElement.WARMUP_COUNT + 1; // prevent re-pause
      this.userPaused = false;
      this.resume();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyC') {
        this.shadow.getElementById('controls')?.classList.toggle('hidden');
        this.shadow.getElementById('hint')?.classList.toggle('hidden');
      } else if (e.code === 'Digit0') {
        this.pendingScreenshot = true;
      }
    });

    this.initialized = true;

    // Ensure boolean attributes with true defaults are present on the element
    // so that removeAttribute() later triggers attributeChangedCallback
    if (!this.hasAttribute('debug-window') && DEFAULTS['debug-window']) {
      this.setAttribute('debug-window', '');
    }
    if (!this.hasAttribute('phantom') && DEFAULTS.phantom) {
      this.setAttribute('phantom', '');
    }

    // Apply all attributes (overriding defaults)
    for (const attr of PathTracerElement.observedAttributes) {
      if (this.hasAttribute(attr) && attr !== 'width' && attr !== 'height' && attr !== 'controls') {
        this.applyAttribute(attr);
      }
    }

    // Start render loop and visibility observer
    this.setupVisibilityObserver();
    this.lastTime = performance.now();
    this.lastFpsUpdate = this.lastTime;
    this.animFrameId = requestAnimationFrame((t) => this.frame(t));
  }

  // --- Scene loading ---
  private async loadDoom() {
    try {
      const response = await fetch(this.assetURL('wads/DOOM1.WAD'));
      if (!response.ok) throw new Error('WAD not found');
      const wadBuffer = await response.arrayBuffer();
      const wad = new WadParser(wadBuffer);
      console.log('Available levels:', wad.getLevelNames());

      const textureExtractor = new TextureExtractor(wad);
      textureExtractor.extractAll();
      this.doomTextureAtlas = textureExtractor.buildAtlas();
      setTextureAtlas(this.doomTextureAtlas);

      const levelData = wad.parseLevel('E1M1');
      this.doomScene = convertLevelToScene(levelData);

      const playerStart = levelData.things.find((t: any) => t.type === 1);
      const startX = playerStart ? playerStart.x / 64 : 0;
      const startZ = playerStart ? playerStart.y / 64 : 0;
      const startAngle = playerStart ? (playerStart.angle * Math.PI / 180) : 0;

      const collision = new CollisionDetector(levelData);
      const floorY = collision.getFloorHeight(startX, startZ);
      const eyeHeight = 0.875;

      this.doomCameraController = new CameraController(
        { x: startX, y: floorY + eyeHeight, z: startZ },
        startAngle - Math.PI / 2, 0, 90, 5, 0.002
      );
      this.doomCameraController.setCollision(collision);
      console.log(`Loaded Doom: ${this.doomScene.triangles.length} triangles`);
    } catch (e) {
      console.warn('Failed to load WAD, using Cornell box:', e);
      this.doomScene = createCornellBox();
      this.doomCameraController = new CameraController(
        { x: 0, y: 0, z: -4.5 }, 0, 0, 60, 3, 0.002
      );
    }
  }

  private async loadDungeon() {
    let dungeonTexIndices: { wall: number; floor: number; ceiling: number } | undefined;
    try {
      const img = new Image();
      img.src = this.assetURL('heretic64x64.png');
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load dungeon atlas'));
      });

      const atlasCanvas = document.createElement('canvas');
      atlasCanvas.width = img.width;
      atlasCanvas.height = img.height;
      const ctx2d = atlasCanvas.getContext('2d')!;
      ctx2d.drawImage(img, 0, 0);
      const imageData = ctx2d.getImageData(0, 0, img.width, img.height);

      const TILE_PX = 64;
      const entries = new Map<string, { name: string; x: number; y: number; width: number; height: number }>();
      entries.set('wall', { name: 'wall', x: 0, y: 0, width: TILE_PX, height: TILE_PX });
      entries.set('floor', { name: 'floor', x: 0, y: 7 * TILE_PX, width: TILE_PX, height: TILE_PX });
      entries.set('ceiling', { name: 'ceiling', x: 4 * TILE_PX, y: 0, width: TILE_PX, height: TILE_PX });

      this.dungeonTextureAtlas = {
        image: new Uint8Array(imageData.data.buffer),
        width: img.width,
        height: img.height,
        entries,
      };
      dungeonTexIndices = { wall: 0, floor: 1, ceiling: 2 };
      console.log(`Dungeon atlas loaded: ${img.width}x${img.height}`);
    } catch (e) {
      console.warn('Failed to load dungeon texture atlas:', e);
    }

    this.dungeonScene = createDungeonScene(dungeonTexIndices);
    this.dungeonCameraController = new DungeonCameraController();

    // Phantom setup
    const phantomMats = createPhantomMaterials(this.dungeonScene.materials.length);
    this.dungeonScene.materials.push(...phantomMats.materials);
    this.dungeonMap = getDungeonMap();
    this.phantomMats = phantomMats.indices;
    this.phantomX = 3 * TILE_SIZE + TILE_SIZE / 2;
    this.phantomZ = 1 * TILE_SIZE + TILE_SIZE / 2;
    this.phantomTriangles = createPhantomTrianglesAt(this.phantomX, this.phantomZ, this.phantomMats);
  }

  private async loadBVH() {
    this.bvhScene = createBVHTeachingScene();
    this.bvhCameraController = new CameraController(
      { x: 0, y: 5, z: 1 }, 0, 0, 90, 5, 0.002
    );
  }

  // --- Scene management ---
  private getSceneData(): { scene: SceneData; atlas: TextureAtlas | null } {
    if (this.activeScene === 'dungeon') return { scene: this.dungeonScene, atlas: this.dungeonTextureAtlas };
    if (this.activeScene === 'bvh') return { scene: this.bvhScene, atlas: null };
    return { scene: this.doomScene, atlas: this.doomTextureAtlas };
  }

  private setActiveCamera() {
    // Detach all cameras
    this.doomCameraController?.detach();
    this.dungeonCameraController?.detach();
    this.bvhCameraController?.detach();

    if (this.activeScene === 'dungeon') {
      this.dungeonCameraController.active = true;
      this.dungeonCameraController.attach(this.canvas, this);
      this.currentCamera = this.dungeonCameraController;
    } else if (this.activeScene === 'bvh') {
      this.bvhCameraController.attach(this.canvas, this);
      this.currentCamera = this.bvhCameraController;
    } else {
      this.doomCameraController.attach(this.canvas, this);
      this.currentCamera = this.doomCameraController;
    }
  }

  private async createRenderer() {
    const { scene, atlas } = this.getSceneData();
    this.renderer = new Renderer(
      this.device, this.gpuContext, this.format,
      this.canvas.width, this.canvas.height,
      this.currentCamera.getCamera(),
      scene.triangles, scene.materials, atlas,
      scene.walkablePositions
    );
    this.renderer.resolutionScale = this.getNum('resolution', DEFAULTS.resolution);
    if (this.activeScene === 'dungeon') {
      this.renderer.renderDistance = this.getNum('render-distance', DEFAULTS['render-distance']) * TILE_SIZE;
    }
    await this.renderer.initialize();

    // Apply all current settings
    this.renderer.samplesPerPixel = this.getNum('samples', DEFAULTS.samples);
    this.renderer.maxBounces = this.getNum('bounces', DEFAULTS.bounces);
    this.renderer.temporalFrames = this.getNum('temporal', DEFAULTS.temporal);
    this.renderer.debugMode = this.getNum('debug-mode', DEFAULTS['debug-mode']);
    this.renderer.debugDepth = this.getNum('debug-depth', DEFAULTS['debug-depth']);
    this.renderer.debugOpacity = this.getNum('debug-opacity', DEFAULTS['debug-opacity']) / 100;
    this.renderer.debugWindow = this.getBool('debug-window', DEFAULTS['debug-window']) ? 1 : 0;
    this.applyDenoise();
    this.applyPlayerLight();
    this.applyPhantom();
  }

  private async recreateRenderer() {
    if (!this.initialized) return;
    this.setActiveCamera();
    await this.createRenderer();
    this.syncControlsToState();
  }

  // --- Attribute application ---
  private applyAttribute(name: string) {
    if (!this.renderer) return;

    switch (name) {
      case 'samples': {
        const v = this.getNum('samples', DEFAULTS.samples);
        this.renderer.samplesPerPixel = v;
        this.syncControl('samples', v, 'samples-value');
        break;
      }
      case 'bounces': {
        const v = this.getNum('bounces', DEFAULTS.bounces);
        this.renderer.maxBounces = v;
        this.syncControl('bounces', v, 'bounces-value');
        break;
      }
      case 'temporal': {
        const v = this.getNum('temporal', DEFAULTS.temporal);
        this.renderer.temporalFrames = v;
        this.syncControl('temporal', v, 'temporal-value');
        break;
      }
      case 'denoise':
      case 'denoise-passes':
        this.applyDenoise();
        break;
      case 'debug-mode': {
        const v = this.getNum('debug-mode', DEFAULTS['debug-mode']);
        this.renderer.debugMode = v;
        this.updateDebugVisibility();
        break;
      }
      case 'debug-opacity': {
        const v = this.getNum('debug-opacity', DEFAULTS['debug-opacity']);
        this.renderer.debugOpacity = v / 100;
        this.syncControl('debug-opacity', v, 'debug-opacity-value', v + '%');
        break;
      }
      case 'debug-window': {
        this.renderer.debugWindow = this.getBool('debug-window', false) ? 1 : 0;
        break;
      }
      case 'debug-depth': {
        const v = this.getNum('debug-depth', DEFAULTS['debug-depth']);
        this.renderer.debugDepth = v;
        this.syncControl('debug-depth', v, 'debug-depth-value');
        break;
      }
      case 'player-light':
      case 'player-falloff':
        this.applyPlayerLight();
        break;
      case 'phantom':
        this.applyPhantom();
        break;
      case 'scene': {
        const v = this.getStr('scene', DEFAULTS.scene) as ActiveScene;
        if (v !== this.activeScene) {
          this.activeScene = v;
          this.recreateRenderer();
        }
        break;
      }
      case 'resolution':
        this.recreateRenderer();
        break;
      case 'render-distance':
        if (this.activeScene === 'dungeon') this.recreateRenderer();
        break;
    }
  }

  private applyDenoise() {
    if (!this.renderer) return;
    const mode = this.getStr('denoise', DEFAULTS.denoise);
    if (mode === 'off') {
      this.renderer.denoisePasses = 0;
    } else {
      this.renderer.denoiseMode = mode as any;
      this.renderer.denoisePasses = this.getNum('denoise-passes', DEFAULTS['denoise-passes']);
    }
  }

  private applyPlayerLight() {
    if (!this.renderer) return;
    const intensity = this.getNum('player-light', DEFAULTS['player-light']) / 10.0;
    const sizeVal = this.getNum('player-falloff', DEFAULTS['player-falloff']);
    if (this.activeScene === 'dungeon' && intensity > 0) {
      this.renderer.playerLightColor = { x: 3.5 * intensity, y: 2.4 * intensity, z: 1.0 * intensity };
      this.renderer.playerLightRadius = sizeVal * 0.02;
    } else {
      this.renderer.playerLightColor = { x: 0, y: 0, z: 0 };
      this.renderer.playerLightRadius = 0;
    }
  }

  private applyPhantom() {
    if (!this.renderer) return;
    if (this.activeScene === 'dungeon' && this.getBool('phantom', DEFAULTS.phantom)) {
      this.renderer.setDynamicTriangles(this.phantomTriangles);
    } else {
      this.renderer.setDynamicTriangles([]);
    }
  }

  // --- Controls panel wiring ---
  private $<T extends HTMLElement>(id: string): T | null {
    return this.shadow.getElementById(id) as T | null;
  }

  private syncControl(sliderId: string, value: number, displayId: string, displayText?: string) {
    const slider = this.$<HTMLInputElement>(sliderId);
    const display = this.$<HTMLSpanElement>(displayId);
    if (slider) slider.value = String(value);
    if (display) display.textContent = displayText ?? String(value);
  }

  private syncControlsToState() {
    if (!this.hasAttribute('controls')) return;

    const sceneSelect = this.$<HTMLSelectElement>('scene-select');
    if (sceneSelect) sceneSelect.value = this.activeScene;

    this.syncControl('samples', this.renderer.samplesPerPixel, 'samples-value');
    this.syncControl('bounces', this.renderer.maxBounces, 'bounces-value');
    this.syncControl('temporal', this.renderer.temporalFrames, 'temporal-value');

    const resSelect = this.$<HTMLSelectElement>('resolution');
    if (resSelect) resSelect.value = String(this.renderer.resolutionScale);

    const denoiseSelect = this.$<HTMLSelectElement>('denoise-mode');
    if (denoiseSelect) denoiseSelect.value = this.renderer.denoisePasses === 0 ? 'off' : this.renderer.denoiseMode;
    this.syncControl('denoise', this.renderer.denoisePasses, 'denoise-value');

    const debugSelect = this.$<HTMLSelectElement>('debug-mode');
    if (debugSelect) debugSelect.value = String(this.renderer.debugMode);

    this.syncControl('debug-opacity', Math.round(this.renderer.debugOpacity * 100), 'debug-opacity-value', Math.round(this.renderer.debugOpacity * 100) + '%');
    this.syncControl('debug-depth', this.renderer.debugDepth, 'debug-depth-value');

    this.syncControl('player-light', this.getNum('player-light', DEFAULTS['player-light']), 'player-light-value');
    this.syncControl('player-falloff', this.getNum('player-falloff', DEFAULTS['player-falloff']), 'player-falloff-value');
    this.syncControl('render-dist', this.getNum('render-distance', DEFAULTS['render-distance']), 'render-dist-value');

    const showDungeon = this.activeScene === 'dungeon' ? '' : 'none';
    this.$<HTMLElement>('player-light-label')!.style.display = showDungeon;
    this.$<HTMLElement>('player-falloff-label')!.style.display = showDungeon;
    this.$<HTMLElement>('render-dist-label')!.style.display = showDungeon;
    this.$<HTMLElement>('phantom-label')!.style.display = showDungeon;

    this.updateDebugVisibility();

    const denoisePassesLabel = this.$<HTMLElement>('denoise-passes-label');
    if (denoisePassesLabel) {
      denoisePassesLabel.style.display = this.renderer.denoisePasses === 0 ? 'none' : '';
    }
  }

  private updateDebugVisibility() {
    const active = this.renderer?.debugMode > 0;
    const opLabel = this.$<HTMLElement>('debug-opacity-label');
    const winLabel = this.$<HTMLElement>('debug-window-label');
    const depLabel = this.$<HTMLElement>('debug-depth-label');
    if (opLabel) opLabel.style.display = active ? '' : 'none';
    if (winLabel) winLabel.style.display = active ? '' : 'none';
    if (depLabel) depLabel.style.display = active ? '' : 'none';
  }

  private wireControls() {
    // Sync initial UI from attributes/defaults
    this.syncControlsToState();

    // Scene selector
    this.$<HTMLSelectElement>('scene-select')?.addEventListener('change', (e) => {
      this.setAttribute('scene', (e.target as HTMLSelectElement).value);
    });

    // Samples
    this.$<HTMLInputElement>('samples')?.addEventListener('input', (e) => {
      this.setAttribute('samples', (e.target as HTMLInputElement).value);
    });

    // Bounces
    this.$<HTMLInputElement>('bounces')?.addEventListener('input', (e) => {
      this.setAttribute('bounces', (e.target as HTMLInputElement).value);
    });

    // Resolution
    this.$<HTMLSelectElement>('resolution')?.addEventListener('change', (e) => {
      this.setAttribute('resolution', (e.target as HTMLSelectElement).value);
    });

    // Temporal
    this.$<HTMLInputElement>('temporal')?.addEventListener('input', (e) => {
      this.setAttribute('temporal', (e.target as HTMLInputElement).value);
    });

    // Denoise mode
    this.$<HTMLSelectElement>('denoise-mode')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.setAttribute('denoise', v);
      const denoisePassesLabel = this.$<HTMLElement>('denoise-passes-label');
      if (denoisePassesLabel) {
        denoisePassesLabel.style.display = v === 'off' ? 'none' : '';
      }
    });

    // Denoise passes
    this.$<HTMLInputElement>('denoise')?.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      this.setAttribute('denoise-passes', v);
      const display = this.$<HTMLSpanElement>('denoise-value');
      if (display) display.textContent = v;
    });

    // Debug mode
    this.$<HTMLSelectElement>('debug-mode')?.addEventListener('change', (e) => {
      this.setAttribute('debug-mode', (e.target as HTMLSelectElement).value);
    });

    // Debug opacity
    this.$<HTMLInputElement>('debug-opacity')?.addEventListener('input', (e) => {
      this.setAttribute('debug-opacity', (e.target as HTMLInputElement).value);
    });

    // Debug window
    this.$<HTMLInputElement>('debug-window')?.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) {
        this.setAttribute('debug-window', '');
      } else {
        this.removeAttribute('debug-window');
      }
    });

    // Debug depth
    this.$<HTMLInputElement>('debug-depth')?.addEventListener('input', (e) => {
      this.setAttribute('debug-depth', (e.target as HTMLInputElement).value);
    });

    // Player light
    this.$<HTMLInputElement>('player-light')?.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      this.setAttribute('player-light', v);
      const display = this.$<HTMLSpanElement>('player-light-value');
      if (display) display.textContent = v;
    });

    // Player falloff
    this.$<HTMLInputElement>('player-falloff')?.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      this.setAttribute('player-falloff', v);
      const display = this.$<HTMLSpanElement>('player-falloff-value');
      if (display) display.textContent = v;
    });

    // Render distance
    const renderDistSlider = this.$<HTMLInputElement>('render-dist');
    renderDistSlider?.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      const display = this.$<HTMLSpanElement>('render-dist-value');
      if (display) display.textContent = v;
    });
    renderDistSlider?.addEventListener('change', (e) => {
      this.setAttribute('render-distance', (e.target as HTMLInputElement).value);
    });

    // Phantom
    this.$<HTMLInputElement>('phantom')?.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) {
        this.setAttribute('phantom', '');
      } else {
        this.removeAttribute('phantom');
      }
    });
  }

  // --- Pause / Play ---
  private pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    const container = this.shadow.getElementById('container');
    container?.classList.add('paused');
    // Only show play button for user-initiated pause (warmup / initial)
    if (this.userPaused) {
      this.shadow.getElementById('play-overlay')?.classList.add('visible');
    }
  }

  private resume() {
    if (!this.paused) return;
    // Don't resume if still user-paused or scroll-paused
    if (this.userPaused || this.scrollPaused) return;
    this.paused = false;
    const container = this.shadow.getElementById('container');
    container?.classList.remove('paused');
    this.shadow.getElementById('play-overlay')?.classList.remove('visible');
    this.lastTime = performance.now();
    this.animFrameId = requestAnimationFrame((t) => this.frame(t));
  }

  private setupVisibilityObserver() {
    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          this.scrollPaused = true;
          this.pause();
        } else {
          this.scrollPaused = false;
          this.resume();
        }
      },
      { threshold: 0 }
    );
    this.intersectionObserver.observe(this);
  }

  // --- Render loop ---
  private frame(currentTime: number) {
    const deltaTime = (currentTime - this.lastTime) / 1000;
    this.lastTime = currentTime;

    this.currentCamera.update(deltaTime);

    // Animate phantom
    if (this.activeScene === 'dungeon' && this.getBool('phantom', DEFAULTS.phantom)) {
      const newZ = this.phantomZ + this.phantomDirZ * this.phantomSpeed * deltaTime;
      const tileX = Math.floor(this.phantomX / TILE_SIZE);
      const tileZ = Math.floor(newZ / TILE_SIZE);
      if (this.dungeonMap[tileZ]?.[tileX] === 1) {
        this.phantomDirZ = -this.phantomDirZ;
      } else {
        this.phantomZ = newZ;
      }
      this.phantomTriangles = createPhantomTrianglesAt(this.phantomX, this.phantomZ, this.phantomMats);
      this.renderer.setDynamicTriangles(this.phantomTriangles);
    }

    this.renderer.updateCamera(this.currentCamera.getCamera());
    this.renderer.render();

    // Screenshot capture (must happen right after render, before next frame clears the canvas)
    if (this.pendingScreenshot) {
      this.pendingScreenshot = false;
      this.canvas.toBlob((blob) => {
        if (!blob) return;
        navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      });
    }

    // Pause after warmup frames
    this.warmupFrames++;
    if (this.warmupFrames === PathTracerElement.WARMUP_COUNT) {
      this.userPaused = true;
      this.pause();
      return;
    }

    // Performance metrics
    this.frameCount++;
    this.fpsAccumulator += deltaTime;
    if (currentTime - this.lastFpsUpdate >= 500) {
      const fps = this.frameCount / this.fpsAccumulator;
      const renderWidth = Math.floor(this.canvas.width * this.renderer.resolutionScale);
      const renderHeight = Math.floor(this.canvas.height * this.renderer.resolutionScale);
      const pixels = renderWidth * renderHeight;
      const samples = this.renderer.samplesPerPixel;
      const raysPerSecond = pixels * samples * fps;

      const fpsEl = this.$<HTMLSpanElement>('fps-value');
      const raysEl = this.$<HTMLSpanElement>('rays-value');
      const samplesEl = this.$<HTMLSpanElement>('samples-display');
      const resEl = this.$<HTMLSpanElement>('res-display');
      if (fpsEl) fpsEl.textContent = fps.toFixed(1);
      if (raysEl) raysEl.textContent = this.formatNumber(raysPerSecond);
      if (samplesEl) samplesEl.textContent = `${samples}/px`;
      if (resEl) resEl.textContent = `${renderWidth}x${renderHeight}`;

      this.frameCount = 0;
      this.fpsAccumulator = 0;
      this.lastFpsUpdate = currentTime;
    }

    this.animFrameId = requestAnimationFrame((t) => this.frame(t));
  }

  private formatNumber(n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }
}

customElements.define('path-tracer', PathTracerElement);
