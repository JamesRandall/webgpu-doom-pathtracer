// WAD File Parser for Doom
// Reference: https://doomwiki.org/wiki/WAD

export interface WadHeader {
  identification: string;  // "IWAD" or "PWAD"
  numLumps: number;
  directoryOffset: number;
}

export interface LumpEntry {
  offset: number;
  size: number;
  name: string;
}

export interface Vertex {
  x: number;
  y: number;
}

export interface Linedef {
  startVertex: number;
  endVertex: number;
  flags: number;
  specialType: number;
  sectorTag: number;
  rightSidedef: number;  // -1 if none
  leftSidedef: number;   // -1 if none
}

export interface Sidedef {
  xOffset: number;
  yOffset: number;
  upperTexture: string;
  lowerTexture: string;
  middleTexture: string;
  sector: number;
}

export interface Sector {
  floorHeight: number;
  ceilingHeight: number;
  floorTexture: string;
  ceilingTexture: string;
  lightLevel: number;
  specialType: number;
  tag: number;
}

export interface Thing {
  x: number;
  y: number;
  angle: number;
  type: number;
  flags: number;
}

export interface Subsector {
  segCount: number;
  firstSeg: number;
}

export interface Seg {
  startVertex: number;
  endVertex: number;
  angle: number;
  linedef: number;
  direction: number;  // 0 = same as linedef, 1 = opposite
  offset: number;
}

export interface LevelData {
  name: string;
  vertices: Vertex[];
  linedefs: Linedef[];
  sidedefs: Sidedef[];
  sectors: Sector[];
  things: Thing[];
  subsectors: Subsector[];
  segs: Seg[];
}

export class WadParser {
  private data: DataView;
  private header: WadHeader;
  private directory: LumpEntry[] = [];

  constructor(buffer: ArrayBuffer) {
    this.data = new DataView(buffer);
    this.header = this.parseHeader();
    this.parseDirectory();
  }

  private parseHeader(): WadHeader {
    const identification = this.readString(0, 4);
    const numLumps = this.data.getInt32(4, true);
    const directoryOffset = this.data.getInt32(8, true);

    if (identification !== 'IWAD' && identification !== 'PWAD') {
      throw new Error(`Invalid WAD identification: ${identification}`);
    }

    return { identification, numLumps, directoryOffset };
  }

  private parseDirectory(): void {
    const { numLumps, directoryOffset } = this.header;

    for (let i = 0; i < numLumps; i++) {
      const entryOffset = directoryOffset + i * 16;
      const offset = this.data.getInt32(entryOffset, true);
      const size = this.data.getInt32(entryOffset + 4, true);
      const name = this.readString(entryOffset + 8, 8).replace(/\0/g, '');

      this.directory.push({ offset, size, name });
    }
  }

  private readString(offset: number, length: number): string {
    let str = '';
    for (let i = 0; i < length; i++) {
      const charCode = this.data.getUint8(offset + i);
      if (charCode === 0) break;
      str += String.fromCharCode(charCode);
    }
    return str;
  }

  getLumpByName(name: string): LumpEntry | undefined {
    return this.directory.find(lump => lump.name === name);
  }

  getLumpIndex(name: string): number {
    return this.directory.findIndex(lump => lump.name === name);
  }

  getLumpData(lump: LumpEntry): DataView {
    return new DataView(this.data.buffer, lump.offset, lump.size);
  }

  getDirectory(): LumpEntry[] {
    return this.directory;
  }

  // Get list of all levels in the WAD (E#M# or MAP##)
  getLevelNames(): string[] {
    const levels: string[] = [];
    for (const lump of this.directory) {
      // Doom 1 format: E1M1, E1M2, etc.
      if (/^E\dM\d$/.test(lump.name)) {
        levels.push(lump.name);
      }
      // Doom 2 format: MAP01, MAP02, etc.
      if (/^MAP\d\d$/.test(lump.name)) {
        levels.push(lump.name);
      }
    }
    return levels;
  }

  // Parse a complete level
  parseLevel(levelName: string): LevelData {
    const levelIndex = this.getLumpIndex(levelName);
    if (levelIndex === -1) {
      throw new Error(`Level ${levelName} not found`);
    }

    // Level lumps follow the level marker in a specific order
    // The level marker itself is a zero-length lump
    const getLumpAfterLevel = (name: string): LumpEntry | undefined => {
      for (let i = levelIndex + 1; i < this.directory.length && i < levelIndex + 12; i++) {
        if (this.directory[i].name === name) {
          return this.directory[i];
        }
      }
      return undefined;
    };

    const verticesLump = getLumpAfterLevel('VERTEXES');
    const linedefsLump = getLumpAfterLevel('LINEDEFS');
    const sidedefsLump = getLumpAfterLevel('SIDEDEFS');
    const sectorsLump = getLumpAfterLevel('SECTORS');
    const thingsLump = getLumpAfterLevel('THINGS');
    const subsectorsLump = getLumpAfterLevel('SSECTORS');
    const segsLump = getLumpAfterLevel('SEGS');

    if (!verticesLump || !linedefsLump || !sidedefsLump || !sectorsLump) {
      throw new Error(`Missing required lumps for level ${levelName}`);
    }

    return {
      name: levelName,
      vertices: this.parseVertices(verticesLump),
      linedefs: this.parseLinedefs(linedefsLump),
      sidedefs: this.parseSidedefs(sidedefsLump),
      sectors: this.parseSectors(sectorsLump),
      things: thingsLump ? this.parseThings(thingsLump) : [],
      subsectors: subsectorsLump ? this.parseSubsectors(subsectorsLump) : [],
      segs: segsLump ? this.parseSegs(segsLump) : [],
    };
  }

  private parseVertices(lump: LumpEntry): Vertex[] {
    const data = this.getLumpData(lump);
    const vertices: Vertex[] = [];
    const count = lump.size / 4;  // 2 shorts per vertex

    for (let i = 0; i < count; i++) {
      const x = data.getInt16(i * 4, true);
      const y = data.getInt16(i * 4 + 2, true);
      vertices.push({ x, y });
    }

    return vertices;
  }

  private parseLinedefs(lump: LumpEntry): Linedef[] {
    const data = this.getLumpData(lump);
    const linedefs: Linedef[] = [];
    const count = lump.size / 14;  // 14 bytes per linedef

    for (let i = 0; i < count; i++) {
      const offset = i * 14;
      linedefs.push({
        startVertex: data.getUint16(offset, true),
        endVertex: data.getUint16(offset + 2, true),
        flags: data.getUint16(offset + 4, true),
        specialType: data.getUint16(offset + 6, true),
        sectorTag: data.getUint16(offset + 8, true),
        rightSidedef: data.getInt16(offset + 10, true),
        leftSidedef: data.getInt16(offset + 12, true),
      });
    }

    return linedefs;
  }

  private parseSidedefs(lump: LumpEntry): Sidedef[] {
    const data = this.getLumpData(lump);
    const sidedefs: Sidedef[] = [];
    const count = lump.size / 30;  // 30 bytes per sidedef

    for (let i = 0; i < count; i++) {
      const offset = i * 30;
      sidedefs.push({
        xOffset: data.getInt16(offset, true),
        yOffset: data.getInt16(offset + 2, true),
        upperTexture: this.readStringFromData(data, offset + 4, 8),
        lowerTexture: this.readStringFromData(data, offset + 12, 8),
        middleTexture: this.readStringFromData(data, offset + 20, 8),
        sector: data.getUint16(offset + 28, true),
      });
    }

    return sidedefs;
  }

  private parseSectors(lump: LumpEntry): Sector[] {
    const data = this.getLumpData(lump);
    const sectors: Sector[] = [];
    const count = lump.size / 26;  // 26 bytes per sector

    for (let i = 0; i < count; i++) {
      const offset = i * 26;
      sectors.push({
        floorHeight: data.getInt16(offset, true),
        ceilingHeight: data.getInt16(offset + 2, true),
        floorTexture: this.readStringFromData(data, offset + 4, 8),
        ceilingTexture: this.readStringFromData(data, offset + 12, 8),
        lightLevel: data.getUint16(offset + 20, true),
        specialType: data.getUint16(offset + 22, true),
        tag: data.getUint16(offset + 24, true),
      });
    }

    return sectors;
  }

  private parseThings(lump: LumpEntry): Thing[] {
    const data = this.getLumpData(lump);
    const things: Thing[] = [];
    const count = lump.size / 10;  // 10 bytes per thing

    for (let i = 0; i < count; i++) {
      const offset = i * 10;
      things.push({
        x: data.getInt16(offset, true),
        y: data.getInt16(offset + 2, true),
        angle: data.getUint16(offset + 4, true),
        type: data.getUint16(offset + 6, true),
        flags: data.getUint16(offset + 8, true),
      });
    }

    return things;
  }

  private parseSubsectors(lump: LumpEntry): Subsector[] {
    const data = this.getLumpData(lump);
    const subsectors: Subsector[] = [];
    const count = lump.size / 4;  // 4 bytes per subsector

    for (let i = 0; i < count; i++) {
      const offset = i * 4;
      subsectors.push({
        segCount: data.getUint16(offset, true),
        firstSeg: data.getUint16(offset + 2, true),
      });
    }

    return subsectors;
  }

  private parseSegs(lump: LumpEntry): Seg[] {
    const data = this.getLumpData(lump);
    const segs: Seg[] = [];
    const count = lump.size / 12;  // 12 bytes per seg

    for (let i = 0; i < count; i++) {
      const offset = i * 12;
      segs.push({
        startVertex: data.getUint16(offset, true),
        endVertex: data.getUint16(offset + 2, true),
        angle: data.getInt16(offset + 4, true),
        linedef: data.getUint16(offset + 6, true),
        direction: data.getUint16(offset + 8, true),
        offset: data.getInt16(offset + 10, true),
      });
    }

    return segs;
  }

  private readStringFromData(data: DataView, offset: number, length: number): string {
    let str = '';
    for (let i = 0; i < length; i++) {
      const charCode = data.getUint8(offset + i);
      if (charCode === 0) break;
      str += String.fromCharCode(charCode);
    }
    return str;
  }
}
