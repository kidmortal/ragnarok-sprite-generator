/**
 * Parser for Ragnarok-style .act animation files, which sequence frames out of
 * the matching .spr. Only the fields needed to play an animation back are kept.
 */

export type ActLayer = {
  x: number;
  y: number;
  sprIndex: number;
  mirror: boolean;
  color: [number, number, number, number];
  scaleX: number;
  scaleY: number;
  rotation: number;
  sprType: number;
  width: number;
  height: number;
};

/**
 * Attach point. Composing a character hangs the head and headgears off the
 * body's anchor: the child's offset is `bodyAnchor - ownAnchor`.
 */
export type ActAnchor = { x: number; y: number; attr: number };

export type ActMotion = { layers: ActLayer[]; anchors: ActAnchor[] };
export type ActAction = { motions: ActMotion[]; delay: number };
export type Act = { version: number; actions: ActAction[] };

class Reader {
  offset = 0;
  constructor(readonly view: DataView) {}
  u8() {
    return this.view.getUint8(this.offset++);
  }
  u16() {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  skip(n: number) {
    this.offset += n;
  }
}

export function parseAct(buffer: ArrayBuffer): Act {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x41 || bytes[1] !== 0x43) {
    throw new Error("Not an .act file (missing AC magic)");
  }
  const version = bytes[3] + bytes[2] / 10;
  const r = new Reader(new DataView(buffer));
  r.offset = 4;

  const actionCount = r.u16();
  r.skip(10); // reserved

  const actions: ActAction[] = [];
  for (let a = 0; a < actionCount; a++) {
    const motionCount = r.u32();
    const motions: ActMotion[] = [];
    for (let m = 0; m < motionCount; m++) {
      r.skip(32); // two unused bounding ranges
      const layerCount = r.u32();
      const layers: ActLayer[] = [];
      for (let l = 0; l < layerCount; l++) {
        const x = r.i32();
        const y = r.i32();
        const sprIndex = r.i32();
        const mirror = r.i32() !== 0;
        let color: [number, number, number, number] = [255, 255, 255, 255];
        let scaleX = 1;
        let scaleY = 1;
        let rotation = 0;
        let sprType = 0;
        let width = 0;
        let height = 0;
        if (version >= 2.0) {
          color = [r.u8(), r.u8(), r.u8(), r.u8()];
          scaleX = r.f32();
          scaleY = version >= 2.4 ? r.f32() : scaleX;
          rotation = r.i32();
          sprType = r.i32();
          if (version >= 2.5) {
            width = r.i32();
            height = r.i32();
          }
        }
        layers.push({ x, y, sprIndex, mirror, color, scaleX, scaleY, rotation, sprType, width, height });
      }
      if (version >= 2.0) r.i32(); // event id
      const anchors: ActAnchor[] = [];
      if (version >= 2.3) {
        const anchorCount = r.i32();
        for (let n = 0; n < anchorCount; n++) {
          r.i32(); // unused
          anchors.push({ x: r.i32(), y: r.i32(), attr: r.i32() });
        }
      }
      motions.push({ layers, anchors });
    }
    actions.push({ motions, delay: 4 });
  }

  if (version >= 2.1) {
    const soundCount = r.i32();
    r.skip(soundCount * 40);
  }
  if (version >= 2.2) {
    for (const action of actions) action.delay = r.f32();
  }

  return { version, actions };
}
