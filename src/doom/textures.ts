// Doom texture extraction and atlas building
import { WadParser, LumpEntry } from './wad-parser';

// Parsed palette (256 RGB colors)
export type Palette = Uint8Array; // 768 bytes (256 * 3)

// Parsed patch (column-based graphic)
export interface Patch {
  name: string;
  width: number;
  height: number;
  leftOffset: number;
  topOffset: number;
  pixels: Uint8Array; // RGBA data (width * height * 4)
}

// Texture definition (how patches combine)
export interface TextureDef {
  name: string;
  width: number;
  height: number;
  patches: Array<{
    originX: number;
    originY: number;
    patchIndex: number;
  }>;
}

// Flat (floor/ceiling texture)
export interface Flat {
  name: string;
  pixels: Uint8Array; // RGBA data (64 * 64 * 4)
}

// Atlas entry for UV lookup
export interface AtlasEntry {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Complete texture atlas
export interface TextureAtlas {
  image: Uint8Array; // RGBA data
  width: number;
  height: number;
  entries: Map<string, AtlasEntry>;
}

export class TextureExtractor {
  private wad: WadParser;
  private palette: Palette | null = null;
  private patchNames: string[] = [];
  private patches: Map<string, Patch> = new Map();
  private textureDefs: Map<string, TextureDef> = new Map();
  private flats: Map<string, Flat> = new Map();
  private composedTextures: Map<string, Uint8Array> = new Map();

  constructor(wad: WadParser) {
    this.wad = wad;
  }

  // Extract all texture data from WAD
  extractAll(): void {
    console.log('Extracting textures from WAD...');

    this.extractPalette();
    this.extractPatchNames();
    this.extractPatches();
    this.extractTextureDefs();
    this.extractFlats();
    this.composeTextures();

    console.log(`Extracted: ${this.patchNames.length} patch names, ${this.patches.size} patches, ${this.textureDefs.size} texture defs, ${this.flats.size} flats`);
  }

  // Parse PLAYPAL lump (256 RGB colors)
  private extractPalette(): void {
    const lump = this.wad.getLumpByName('PLAYPAL');
    if (!lump) {
      console.warn('PLAYPAL not found');
      return;
    }

    const data = this.wad.getLumpData(lump);
    // PLAYPAL contains 14 palettes, we only need the first one
    this.palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) {
      this.palette[i] = data.getUint8(i);
    }

    console.log('Extracted palette');
  }

  // Parse PNAMES lump (list of patch names)
  private extractPatchNames(): void {
    const lump = this.wad.getLumpByName('PNAMES');
    if (!lump) {
      console.warn('PNAMES not found');
      return;
    }

    const data = this.wad.getLumpData(lump);
    const count = data.getInt32(0, true);

    for (let i = 0; i < count; i++) {
      let name = '';
      for (let j = 0; j < 8; j++) {
        const c = data.getUint8(4 + i * 8 + j);
        if (c === 0) break;
        name += String.fromCharCode(c);
      }
      this.patchNames.push(name.toUpperCase());
    }

    console.log(`Extracted ${this.patchNames.length} patch names`);
  }

  // Parse patches between P_START/P_END or PP_START/PP_END markers
  private extractPatches(): void {
    if (!this.palette) return;

    const directory = this.wad.getDirectory();

    // Find patch markers - DOOM1.WAD uses P1_START/P1_END and P2_START/P2_END
    // or just has patches listed in PNAMES that we can find by name

    // Try to extract patches by name from PNAMES
    for (const patchName of this.patchNames) {
      if (this.patches.has(patchName)) continue;

      const lump = this.wad.getLumpByName(patchName);
      if (lump && lump.size > 0) {
        const patch = this.parsePatch(lump, patchName);
        if (patch) {
          this.patches.set(patchName, patch);
        }
      }
    }

    // Also scan between P_START/P_END markers
    let inPatchBlock = false;
    for (let i = 0; i < directory.length; i++) {
      const lump = directory[i];
      const name = lump.name.toUpperCase();

      if (name === 'P_START' || name === 'P1_START' || name === 'P2_START' || name === 'PP_START') {
        inPatchBlock = true;
        continue;
      }
      if (name === 'P_END' || name === 'P1_END' || name === 'P2_END' || name === 'PP_END') {
        inPatchBlock = false;
        continue;
      }

      if (inPatchBlock && lump.size > 0 && !this.patches.has(name)) {
        const patch = this.parsePatch(lump, name);
        if (patch) {
          this.patches.set(name, patch);
        }
      }
    }

    console.log(`Extracted ${this.patches.size} patches`);
  }

  // Parse a single patch (column-based picture format)
  private parsePatch(lump: LumpEntry, name: string): Patch | null {
    if (!this.palette) return null;

    try {
      const data = this.wad.getLumpData(lump);

      const width = data.getUint16(0, true);
      const height = data.getUint16(2, true);
      const leftOffset = data.getInt16(4, true);
      const topOffset = data.getInt16(6, true);

      // Sanity checks
      if (width === 0 || height === 0 || width > 4096 || height > 4096) {
        return null;
      }

      // Create RGBA pixel buffer
      const pixels = new Uint8Array(width * height * 4);
      // Initialize to transparent
      pixels.fill(0);

      // Read column offsets
      const columnOffsets: number[] = [];
      for (let x = 0; x < width; x++) {
        columnOffsets.push(data.getUint32(8 + x * 4, true));
      }

      // Parse each column
      for (let x = 0; x < width; x++) {
        let offset = columnOffsets[x];

        // Safety check
        if (offset >= lump.size) continue;

        while (true) {
          const rowStart = data.getUint8(offset);
          if (rowStart === 255) break; // End of column

          const pixelCount = data.getUint8(offset + 1);
          // Skip dummy byte
          offset += 3;

          for (let i = 0; i < pixelCount; i++) {
            const y = rowStart + i;
            if (y >= height) break;

            const paletteIndex = data.getUint8(offset + i);
            const pixelOffset = (y * width + x) * 4;

            pixels[pixelOffset] = this.palette[paletteIndex * 3];
            pixels[pixelOffset + 1] = this.palette[paletteIndex * 3 + 1];
            pixels[pixelOffset + 2] = this.palette[paletteIndex * 3 + 2];
            pixels[pixelOffset + 3] = 255; // Opaque
          }

          offset += pixelCount + 1; // Skip dummy byte at end
        }
      }

      return { name, width, height, leftOffset, topOffset, pixels };
    } catch (e) {
      // Invalid patch format
      return null;
    }
  }

  // Parse TEXTURE1 and TEXTURE2 lumps
  private extractTextureDefs(): void {
    for (const textureLump of ['TEXTURE1', 'TEXTURE2']) {
      const lump = this.wad.getLumpByName(textureLump);
      if (!lump) continue;

      const data = this.wad.getLumpData(lump);
      const numTextures = data.getInt32(0, true);

      // Read texture offsets
      const offsets: number[] = [];
      for (let i = 0; i < numTextures; i++) {
        offsets.push(data.getInt32(4 + i * 4, true));
      }

      // Parse each texture definition
      for (const offset of offsets) {
        let name = '';
        for (let j = 0; j < 8; j++) {
          const c = data.getUint8(offset + j);
          if (c === 0) break;
          name += String.fromCharCode(c);
        }
        name = name.toUpperCase();

        // Skip masked flag (4 bytes) at offset + 8
        const width = data.getUint16(offset + 12, true);
        const height = data.getUint16(offset + 14, true);
        // Skip column directory (4 bytes) at offset + 16
        const patchCount = data.getUint16(offset + 20, true);

        const patches: TextureDef['patches'] = [];
        for (let p = 0; p < patchCount; p++) {
          const patchOffset = offset + 22 + p * 10;
          patches.push({
            originX: data.getInt16(patchOffset, true),
            originY: data.getInt16(patchOffset + 2, true),
            patchIndex: data.getUint16(patchOffset + 4, true),
            // Skip step dir (2) and colormap (2)
          });
        }

        this.textureDefs.set(name, { name, width, height, patches });
      }
    }

    console.log(`Extracted ${this.textureDefs.size} texture definitions`);
  }

  // Parse flats between F_START/F_END markers
  private extractFlats(): void {
    if (!this.palette) return;

    const directory = this.wad.getDirectory();
    let inFlatBlock = false;

    for (let i = 0; i < directory.length; i++) {
      const lump = directory[i];
      const name = lump.name.toUpperCase();

      if (name === 'F_START' || name === 'F1_START' || name === 'F2_START' || name === 'FF_START') {
        inFlatBlock = true;
        continue;
      }
      if (name === 'F_END' || name === 'F1_END' || name === 'F2_END' || name === 'FF_END') {
        inFlatBlock = false;
        continue;
      }

      // Flats are 64x64 = 4096 bytes
      if (inFlatBlock && lump.size === 4096) {
        const flat = this.parseFlat(lump, name);
        if (flat) {
          this.flats.set(name, flat);
        }
      }
    }

    console.log(`Extracted ${this.flats.size} flats`);
  }

  // Parse a flat (64x64 raw pixels)
  private parseFlat(lump: LumpEntry, name: string): Flat | null {
    if (!this.palette) return null;

    const data = this.wad.getLumpData(lump);
    const pixels = new Uint8Array(64 * 64 * 4);

    for (let i = 0; i < 4096; i++) {
      const paletteIndex = data.getUint8(i);
      pixels[i * 4] = this.palette[paletteIndex * 3];
      pixels[i * 4 + 1] = this.palette[paletteIndex * 3 + 1];
      pixels[i * 4 + 2] = this.palette[paletteIndex * 3 + 2];
      pixels[i * 4 + 3] = 255;
    }

    return { name, pixels };
  }

  // Compose final textures from patches
  private composeTextures(): void {
    for (const [name, def] of this.textureDefs) {
      const pixels = new Uint8Array(def.width * def.height * 4);
      // Initialize to transparent magenta (for debugging missing patches)
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 255;     // R
        pixels[i + 1] = 0;   // G
        pixels[i + 2] = 255; // B
        pixels[i + 3] = 0;   // A (transparent)
      }

      // Composite patches
      for (const patchRef of def.patches) {
        if (patchRef.patchIndex >= this.patchNames.length) continue;

        const patchName = this.patchNames[patchRef.patchIndex];
        const patch = this.patches.get(patchName);
        if (!patch) continue;

        // Copy patch pixels to texture
        for (let py = 0; py < patch.height; py++) {
          const destY = patchRef.originY + py;
          if (destY < 0 || destY >= def.height) continue;

          for (let px = 0; px < patch.width; px++) {
            const destX = patchRef.originX + px;
            if (destX < 0 || destX >= def.width) continue;

            const srcOffset = (py * patch.width + px) * 4;
            const destOffset = (destY * def.width + destX) * 4;

            // Only copy if source is opaque
            if (patch.pixels[srcOffset + 3] > 0) {
              pixels[destOffset] = patch.pixels[srcOffset];
              pixels[destOffset + 1] = patch.pixels[srcOffset + 1];
              pixels[destOffset + 2] = patch.pixels[srcOffset + 2];
              pixels[destOffset + 3] = patch.pixels[srcOffset + 3];
            }
          }
        }
      }

      this.composedTextures.set(name, pixels);
    }

    console.log(`Composed ${this.composedTextures.size} textures`);
  }

  // Build texture atlas containing all textures and flats
  buildAtlas(): TextureAtlas {
    const entries = new Map<string, AtlasEntry>();

    // Collect all images to pack
    const images: Array<{ name: string; width: number; height: number; pixels: Uint8Array }> = [];

    // Add composed textures
    for (const [name, def] of this.textureDefs) {
      const pixels = this.composedTextures.get(name);
      if (pixels) {
        images.push({ name, width: def.width, height: def.height, pixels });
      }
    }

    // Add flats
    for (const [name, flat] of this.flats) {
      images.push({ name, width: 64, height: 64, pixels: flat.pixels });
    }

    if (images.length === 0) {
      // Return empty atlas
      return {
        image: new Uint8Array(4),
        width: 1,
        height: 1,
        entries,
      };
    }

    // Sort by height descending for better packing
    images.sort((a, b) => b.height - a.height);

    // Simple shelf packing algorithm
    // Determine atlas size (power of 2)
    let atlasSize = 1024;
    let packed = false;

    while (!packed && atlasSize <= 8192) {
      entries.clear();

      let shelfY = 0;
      let shelfHeight = 0;
      let shelfX = 0;
      packed = true;

      for (const img of images) {
        // Check if fits on current shelf
        if (shelfX + img.width > atlasSize) {
          // Move to next shelf
          shelfY += shelfHeight;
          shelfHeight = 0;
          shelfX = 0;
        }

        // Check if fits vertically
        if (shelfY + img.height > atlasSize) {
          packed = false;
          break;
        }

        entries.set(img.name, {
          name: img.name,
          x: shelfX,
          y: shelfY,
          width: img.width,
          height: img.height,
        });

        shelfX += img.width;
        shelfHeight = Math.max(shelfHeight, img.height);
      }

      if (!packed) {
        atlasSize *= 2;
      }
    }

    if (!packed) {
      console.error('Failed to pack all textures into atlas');
    }

    console.log(`Atlas size: ${atlasSize}x${atlasSize}, ${entries.size} textures`);

    // Create atlas image
    const atlasPixels = new Uint8Array(atlasSize * atlasSize * 4);
    // Initialize to magenta for debugging
    for (let i = 0; i < atlasPixels.length; i += 4) {
      atlasPixels[i] = 255;
      atlasPixels[i + 1] = 0;
      atlasPixels[i + 2] = 255;
      atlasPixels[i + 3] = 255;
    }

    // Copy textures to atlas
    for (const img of images) {
      const entry = entries.get(img.name);
      if (!entry) continue;

      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const srcOffset = (y * img.width + x) * 4;
          const destOffset = ((entry.y + y) * atlasSize + (entry.x + x)) * 4;

          atlasPixels[destOffset] = img.pixels[srcOffset];
          atlasPixels[destOffset + 1] = img.pixels[srcOffset + 1];
          atlasPixels[destOffset + 2] = img.pixels[srcOffset + 2];
          atlasPixels[destOffset + 3] = img.pixels[srcOffset + 3];
        }
      }
    }

    return {
      image: atlasPixels,
      width: atlasSize,
      height: atlasSize,
      entries,
    };
  }

  // Get texture dimensions for UV calculation
  getTextureDimensions(name: string): { width: number; height: number } | null {
    const upperName = name.toUpperCase().replace(/\0/g, '');

    // Check texture defs
    const texDef = this.textureDefs.get(upperName);
    if (texDef) {
      return { width: texDef.width, height: texDef.height };
    }

    // Check flats (always 64x64)
    if (this.flats.has(upperName)) {
      return { width: 64, height: 64 };
    }

    return null;
  }

  // Check if a texture name is valid
  hasTexture(name: string): boolean {
    const upperName = name.toUpperCase().replace(/\0/g, '');
    return this.textureDefs.has(upperName) || this.flats.has(upperName);
  }
}
