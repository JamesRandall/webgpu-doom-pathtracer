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

type ActiveScene = 'doom' | 'dungeon';

async function main() {
  const errorDiv = document.getElementById('error') as HTMLDivElement;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  if (!navigator.gpu) {
    errorDiv.textContent = 'WebGPU is not supported in this browser. Please use Chrome or Edge with WebGPU enabled.';
    errorDiv.style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    errorDiv.textContent = 'Failed to get WebGPU adapter. Please ensure your browser supports WebGPU.';
    errorDiv.style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const device = await adapter.requestDevice();

  const context = canvas.getContext('webgpu');
  if (!context) {
    errorDiv.textContent = 'Failed to get WebGPU context.';
    errorDiv.style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  // --- Scene 1: Doom (or Cornell box fallback) ---
  let doomScene: SceneData;
  let doomCameraController: CameraController;
  let doomTextureAtlas: TextureAtlas | null = null;

  try {
    const response = await fetch('/wads/DOOM1.WAD');
    if (!response.ok) throw new Error('WAD not found');
    const wadBuffer = await response.arrayBuffer();
    const wad = new WadParser(wadBuffer);

    console.log('Available levels:', wad.getLevelNames());

    const textureExtractor = new TextureExtractor(wad);
    textureExtractor.extractAll();
    doomTextureAtlas = textureExtractor.buildAtlas();

    setTextureAtlas(doomTextureAtlas);

    const levelData = wad.parseLevel('E1M1');
    doomScene = convertLevelToScene(levelData);

    const playerStart = levelData.things.find(t => t.type === 1);
    const startX = playerStart ? playerStart.x / 64 : 0;
    const startZ = playerStart ? playerStart.y / 64 : 0;
    const startAngle = playerStart ? (playerStart.angle * Math.PI / 180) : 0;

    const collision = new CollisionDetector(levelData);
    const floorY = collision.getFloorHeight(startX, startZ);
    const eyeHeight = 0.875;

    doomCameraController = new CameraController(
      { x: startX, y: floorY + eyeHeight, z: startZ },
      startAngle - Math.PI / 2,
      0,
      90,
      5,
      0.002
    );

    doomCameraController.setCollision(collision);

    console.log(`Loaded Doom: ${doomScene.triangles.length} triangles, ${doomScene.materials.length} materials`);
  } catch (e) {
    console.warn('Failed to load WAD, using Cornell box:', e);

    doomScene = createCornellBox();
    doomCameraController = new CameraController(
      { x: 0, y: 0, z: -4.5 },
      0,
      0,
      60,
      3,
      0.002
    );

    console.log(`Scene: ${doomScene.triangles.length} triangles, ${doomScene.materials.length} materials`);
  }

  // --- Scene 2: Dungeon Crawler ---
  // Load dungeon texture atlas (10x8 grid of 64x64 tiles)
  let dungeonTextureAtlas: TextureAtlas | null = null;
  const ATLAS_COLS = 10;
  const ATLAS_ROWS = 8;
  const TILE_PX = 64;
  let dungeonTexIndices: { wall: number; floor: number; ceiling: number } | undefined;

  try {
    const img = new Image();
    img.src = '/heretic64x64.png';
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

    const entries = new Map<string, { name: string; x: number; y: number; width: number; height: number }>();
    // Wall texture: tile (0,0)
    entries.set('wall', { name: 'wall', x: 0 * TILE_PX, y: 0 * TILE_PX, width: TILE_PX, height: TILE_PX });
    // Floor texture: tile (0,7)
    entries.set('floor', { name: 'floor', x: 0 * TILE_PX, y: 7 * TILE_PX, width: TILE_PX, height: TILE_PX });
    // Ceiling texture: tile (4,0)
    entries.set('ceiling', { name: 'ceiling', x: 4 * TILE_PX, y: 0 * TILE_PX, width: TILE_PX, height: TILE_PX });

    dungeonTextureAtlas = {
      image: new Uint8Array(imageData.data.buffer),
      width: img.width,
      height: img.height,
      entries,
    };

    // Atlas entry indices match iteration order: wall=0, floor=1, ceiling=2
    dungeonTexIndices = { wall: 0, floor: 1, ceiling: 2 };
    console.log(`Dungeon atlas loaded: ${img.width}x${img.height}`);
  } catch (e) {
    console.warn('Failed to load dungeon texture atlas:', e);
  }

  const dungeonScene = createDungeonScene(dungeonTexIndices);
  const dungeonCameraController = new DungeonCameraController();

  // Create phantom monster — moves back and forth
  const phantomMats = createPhantomMaterials(dungeonScene.materials.length);
  dungeonScene.materials.push(...phantomMats.materials);
  const dungeonMap = getDungeonMap();
  const phantomX = 3 * TILE_SIZE + TILE_SIZE / 2; // world X (fixed column)
  let phantomZ = 1 * TILE_SIZE + TILE_SIZE / 2; // world Z
  let phantomDirZ = 1; // moving in +Z direction
  const phantomSpeed = 1.0; // world units per second
  let phantomTriangles = createPhantomTrianglesAt(phantomX, phantomZ, phantomMats.indices);

  // --- Scene switching ---
  let activeScene = 'doom' as ActiveScene;
  let currentCamera: { update(dt: number): void; getCamera(): Camera; attach(c: HTMLCanvasElement): void } = doomCameraController;

  function getActiveSceneData(): { scene: SceneData; atlas: TextureAtlas | null } {
    if (activeScene === 'dungeon') {
      return { scene: dungeonScene, atlas: dungeonTextureAtlas };
    }
    return { scene: doomScene, atlas: doomTextureAtlas };
  }

  // Attach both controllers for input, but only the active one will be updated
  doomCameraController.attach(canvas);
  dungeonCameraController.attach(canvas);
  dungeonCameraController.active = false;

  let { scene, atlas } = getActiveSceneData();
  let renderer = new Renderer(device, context, format, canvas.width, canvas.height, currentCamera.getCamera(), scene.triangles, scene.materials, atlas, scene.walkablePositions);
  await renderer.initialize();

  // UI Controls
  const samplesSlider = document.getElementById('samples') as HTMLInputElement;
  const samplesValue = document.getElementById('samples-value') as HTMLSpanElement;
  const bouncesSlider = document.getElementById('bounces') as HTMLInputElement;
  const bouncesValue = document.getElementById('bounces-value') as HTMLSpanElement;
  const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
  const temporalSlider = document.getElementById('temporal') as HTMLInputElement;
  const temporalValue = document.getElementById('temporal-value') as HTMLSpanElement;
  const denoiseSlider = document.getElementById('denoise') as HTMLInputElement;
  const denoiseValue = document.getElementById('denoise-value') as HTMLSpanElement;
  const denoiseModeSelect = document.getElementById('denoise-mode') as HTMLSelectElement;
  const denoisePassesLabel = document.getElementById('denoise-passes-label') as HTMLLabelElement;
  const playerLightSlider = document.getElementById('player-light') as HTMLInputElement;
  const playerLightValue = document.getElementById('player-light-value') as HTMLSpanElement;
  const playerLightLabel = document.getElementById('player-light-label') as HTMLLabelElement;
  const playerFalloffSlider = document.getElementById('player-falloff') as HTMLInputElement;
  const playerFalloffValue = document.getElementById('player-falloff-value') as HTMLSpanElement;
  const playerFalloffLabel = document.getElementById('player-falloff-label') as HTMLLabelElement;
  const renderDistSlider = document.getElementById('render-dist') as HTMLInputElement;
  const renderDistValue = document.getElementById('render-dist-value') as HTMLSpanElement;
  const renderDistLabel = document.getElementById('render-dist-label') as HTMLLabelElement;
  const phantomCheckbox = document.getElementById('phantom') as HTMLInputElement;
  const phantomLabel = document.getElementById('phantom-label') as HTMLLabelElement;
  const debugModeSelect = document.getElementById('debug-mode') as HTMLSelectElement;
  const debugOpacitySlider = document.getElementById('debug-opacity') as HTMLInputElement;
  const debugOpacityValue = document.getElementById('debug-opacity-value') as HTMLSpanElement;
  const debugOpacityLabel = document.getElementById('debug-opacity-label') as HTMLLabelElement;
  const debugWindowCheckbox = document.getElementById('debug-window') as HTMLInputElement;
  const debugWindowLabel = document.getElementById('debug-window-label') as HTMLLabelElement;
  const debugDepthSlider = document.getElementById('debug-depth') as HTMLInputElement;
  const debugDepthValue = document.getElementById('debug-depth-value') as HTMLSpanElement;
  const debugDepthLabel = document.getElementById('debug-depth-label') as HTMLLabelElement;

  // Set initial values from renderer
  samplesSlider.value = String(renderer.samplesPerPixel);
  samplesValue.textContent = String(renderer.samplesPerPixel);
  bouncesSlider.value = String(renderer.maxBounces);
  bouncesValue.textContent = String(renderer.maxBounces);
  resolutionSelect.value = String(Renderer.RESOLUTION_SCALE);
  temporalSlider.value = String(renderer.temporalFrames);
  temporalValue.textContent = String(renderer.temporalFrames);
  // Denoise: sync UI with renderer defaults
  if (renderer.denoisePasses === 0) {
    denoiseModeSelect.value = 'off';
    denoisePassesLabel.style.display = 'none';
  } else {
    denoiseModeSelect.value = renderer.denoiseMode;
    denoiseSlider.value = String(renderer.denoisePasses);
    denoiseValue.textContent = String(renderer.denoisePasses);
    denoisePassesLabel.style.display = '';
  }

  samplesSlider.addEventListener('input', () => {
    const samples = parseInt(samplesSlider.value);
    renderer.samplesPerPixel = samples;
    samplesValue.textContent = String(samples);
  });

  // Max bounces
  bouncesSlider.addEventListener('input', () => {
    const bounces = parseInt(bouncesSlider.value);
    renderer.maxBounces = bounces;
    bouncesValue.textContent = String(bounces);
  });

  // Helper to recreate the renderer with current scene
  async function recreateRenderer() {
    const data = getActiveSceneData();
    scene = data.scene;
    atlas = data.atlas;
    renderer = new Renderer(device, context, format, canvas.width, canvas.height, currentCamera.getCamera(), scene.triangles, scene.materials, atlas, scene.walkablePositions);
    // Set render distance BEFORE initialize (needed for BVH precomputation)
    if (activeScene === 'dungeon') {
      renderer.renderDistance = parseInt(renderDistSlider.value) * TILE_SIZE;
    }
    await renderer.initialize();
    renderer.samplesPerPixel = parseInt(samplesSlider.value);
    renderer.maxBounces = parseInt(bouncesSlider.value);
    renderer.temporalFrames = parseInt(temporalSlider.value);
    renderer.debugMode = parseInt(debugModeSelect.value);
    renderer.debugDepth = parseInt(debugDepthSlider.value);
    renderer.debugOpacity = parseInt(debugOpacitySlider.value) / 100;
    renderer.debugWindow = debugWindowCheckbox.checked ? 1 : 0;
    applyDenoise();
    const showDungeon = activeScene === 'dungeon' ? '' : 'none';
    playerLightLabel.style.display = showDungeon;
    playerFalloffLabel.style.display = showDungeon;
    renderDistLabel.style.display = showDungeon;
    phantomLabel.style.display = showDungeon;
    applyPhantom();
    applyPlayerLight();
  }

  // Scene switching: 1 = Doom, 2 = Dungeon
  window.addEventListener('keydown', async (e) => {
    if (e.code === 'Digit1' && activeScene !== 'doom') {
      activeScene = 'doom';
      currentCamera = doomCameraController;
      dungeonCameraController.active = false;
      await recreateRenderer();
      console.log('Switched to Doom scene');
    } else if (e.code === 'Digit2' && activeScene !== 'dungeon') {
      activeScene = 'dungeon';
      currentCamera = dungeonCameraController;
      dungeonCameraController.active = true;
      await recreateRenderer();
      console.log('Switched to Dungeon scene');
    }
  });

  // Resolution scale (requires recreating renderer)
  resolutionSelect.addEventListener('change', async () => {
    Renderer.RESOLUTION_SCALE = parseFloat(resolutionSelect.value);
    await recreateRenderer();
  });

  // Temporal reprojection
  temporalSlider.addEventListener('input', () => {
    const frames = parseInt(temporalSlider.value);
    renderer.temporalFrames = frames;
    temporalValue.textContent = String(frames);
  });

  // Spatial denoise
  function applyDenoise() {
    const mode = denoiseModeSelect.value;
    if (mode === 'off') {
      renderer.denoisePasses = 0;
      denoisePassesLabel.style.display = 'none';
    } else {
      renderer.denoiseMode = mode as 'atrous' | 'median' | 'adaptive';
      renderer.denoisePasses = parseInt(denoiseSlider.value);
      denoisePassesLabel.style.display = '';
    }
  }
  denoiseModeSelect.addEventListener('change', applyDenoise);
  denoiseSlider.addEventListener('input', () => {
    renderer.denoisePasses = parseInt(denoiseSlider.value);
    denoiseValue.textContent = String(denoiseSlider.value);
  });

  // Debug BVH visualisation
  function updateDebugVisibility() {
    const active = renderer.debugMode > 0;
    debugOpacityLabel.style.display = active ? '' : 'none';
    debugWindowLabel.style.display = active ? '' : 'none';
    debugDepthLabel.style.display = renderer.debugMode === 4 ? '' : 'none';
  }
  debugModeSelect.addEventListener('change', () => {
    renderer.debugMode = parseInt(debugModeSelect.value);
    updateDebugVisibility();
  });
  debugOpacitySlider.addEventListener('input', () => {
    renderer.debugOpacity = parseInt(debugOpacitySlider.value) / 100;
    debugOpacityValue.textContent = debugOpacitySlider.value + '%';
  });
  debugWindowCheckbox.addEventListener('change', () => {
    renderer.debugWindow = debugWindowCheckbox.checked ? 1 : 0;
  });
  debugDepthSlider.addEventListener('input', () => {
    renderer.debugDepth = parseInt(debugDepthSlider.value);
    debugDepthValue.textContent = debugDepthSlider.value;
  });

  // Player torch light intensity and size
  function applyPlayerLight() {
    const intensity = parseFloat(playerLightSlider.value) / 10.0;
    const sizeVal = parseFloat(playerFalloffSlider.value);
    playerLightValue.textContent = playerLightSlider.value;
    playerFalloffValue.textContent = playerFalloffSlider.value;
    if (activeScene === 'dungeon' && intensity > 0) {
      renderer.playerLightColor = { x: 3.5 * intensity, y: 2.4 * intensity, z: 1.0 * intensity };
      // Sphere radius: slider 1-20 maps to radius 0.02-0.4
      renderer.playerLightRadius = sizeVal * 0.02;
    } else {
      renderer.playerLightColor = { x: 0, y: 0, z: 0 };
      renderer.playerLightRadius = 0;
    }
  }
  playerLightSlider.addEventListener('input', applyPlayerLight);
  playerFalloffSlider.addEventListener('input', applyPlayerLight);

  // View distance (in tiles) — changing requires BVH rebuild
  renderDistSlider.addEventListener('input', () => {
    renderDistValue.textContent = renderDistSlider.value;
  });
  renderDistSlider.addEventListener('change', async () => {
    if (activeScene === 'dungeon') {
      await recreateRenderer();
    }
  });

  // Phantom toggle
  function applyPhantom() {
    if (activeScene === 'dungeon' && phantomCheckbox.checked) {
      renderer.setDynamicTriangles(phantomTriangles);
    } else {
      renderer.setDynamicTriangles([]);
    }
  }
  phantomCheckbox.addEventListener('change', applyPhantom);

  // Apply initial scene-specific settings
  {
    const showDungeon = activeScene === 'dungeon' ? '' : 'none';
    playerLightLabel.style.display = showDungeon;
    playerFalloffLabel.style.display = showDungeon;
    renderDistLabel.style.display = showDungeon;
    phantomLabel.style.display = showDungeon;
    if (activeScene === 'dungeon') {
      renderer.renderDistance = parseInt(renderDistSlider.value) * TILE_SIZE;
      applyPhantom();
      applyPlayerLight();
    }
  }

  let lastTime = performance.now();
  const fpsValueElement = document.getElementById('fps-value') as HTMLSpanElement;
  const raysValueElement = document.getElementById('rays-value') as HTMLSpanElement;
  const samplesDisplayElement = document.getElementById('samples-display') as HTMLSpanElement;
  const resDisplayElement = document.getElementById('res-display') as HTMLSpanElement;
  let frameCount = 0;
  let fpsAccumulator = 0;
  let lastFpsUpdate = performance.now();

  // Helper to format large numbers
  function formatNumber(n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  function frame(currentTime: number) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    currentCamera.update(deltaTime);

    // Animate phantom
    if (activeScene === 'dungeon' && phantomCheckbox.checked) {
      const newZ = phantomZ + phantomDirZ * phantomSpeed * deltaTime;
      // Check if next tile in movement direction is a wall
      const tileX = Math.floor(phantomX / TILE_SIZE);
      const tileZ = Math.floor(newZ / TILE_SIZE);
      if (dungeonMap[tileZ]?.[tileX] === 1) {
        phantomDirZ = -phantomDirZ; // reverse
      } else {
        phantomZ = newZ;
      }
      phantomTriangles = createPhantomTrianglesAt(phantomX, phantomZ, phantomMats.indices);
      renderer.setDynamicTriangles(phantomTriangles);
    }

    renderer.updateCamera(currentCamera.getCamera());
    renderer.render();

    // Performance metrics tracking
    frameCount++;
    fpsAccumulator += deltaTime;
    if (currentTime - lastFpsUpdate >= 500) {
      const fps = frameCount / fpsAccumulator;

      // Calculate rays per second
      // Render resolution
      const renderWidth = Math.floor(canvas.width * Renderer.RESOLUTION_SCALE);
      const renderHeight = Math.floor(canvas.height * Renderer.RESOLUTION_SCALE);
      const pixels = renderWidth * renderHeight;
      const samples = renderer.samplesPerPixel;
      const raysPerSecond = pixels * samples * fps;

      // Update display
      fpsValueElement.textContent = fps.toFixed(1);
      raysValueElement.textContent = formatNumber(raysPerSecond);
      samplesDisplayElement.textContent = `${samples}/px`;
      resDisplayElement.textContent = `${renderWidth}x${renderHeight}`;

      frameCount = 0;
      fpsAccumulator = 0;
      lastFpsUpdate = currentTime;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
