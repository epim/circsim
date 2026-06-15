/**
 * core/kicad/types.ts
 *
 * Normative BoardModel types — copied verbatim from spec §8.2.
 * DO NOT modify shapes without updating the spec.
 */

export type Vec2 = { x: number; y: number };

// Raw Edge.Cuts primitives (input to outline stitching). KiCad 6+ arcs are the
// three-point form: start/mid/end are points ON the arc (mid ≠ center).
export type EdgePrimitive =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; start: Vec2; mid: Vec2; end: Vec2 }
  | { kind: 'circle'; center: Vec2; radiusPoint: Vec2 }
  | { kind: 'rect'; start: Vec2; end: Vec2 };

// Copper tracks: discriminated union; arcs use the same three-point form.
export type TrackSegment =
  | { kind: 'segment'; start: Vec2; end: Vec2; widthMm: number; layer: string; netId: number }
  | { kind: 'arc'; start: Vec2; mid: Vec2; end: Vec2; widthMm: number; layer: string; netId: number };

export interface BoardModel {
  netById: Map<number, { id: number; name: string }>;
  footprints: Footprint[];
  tracks: TrackSegment[];
  vias: Via[];                 // at, size, drill, layers, netId
  zones: Zone[];               // filled polygons with holes, netId, layer
  edgeCuts: EdgePrimitive[];   // raw, in file order
  outline: OutlineGeometry;    // stitched from edgeCuts (see below)
  silkscreen: BoardText[];     // gr_text + fp_text on F.SilkS/F.Silkscreen + B equivalents
  boardThicknessMm: number;    // from (general (thickness …)), default 1.6
}

export interface OutlineGeometry { outer: Vec2[][]; holes: Vec2[][]; warnings: string[] }
// Multiple outer loops are legal (panelized/odd boards): the substrate builder
// creates one THREE.Shape per outer loop (holes assigned by containment) and
// merges the extrusions. Parsers must default absent rotation to rotDeg: 0.

export interface Footprint {
  ref: string; value: string; libId: string;          // "Resistor_SMD:R_0402"
  layer: 'F' | 'B'; at: { x: number; y: number; rotDeg: number };
  pads: Pad[];
  model3d?: { path: string; offset: Xyz; scale: Xyz; rotate: Xyz }; // path may contain ${KICAD*_3DMODEL_DIR}
  properties: Record<string, string>;                  // MPN, datasheet, etc. if present
  courtyardBounds?: { w: number; h: number };          // from F.CrtYd, for placeholder boxes
}

export interface Pad {
  number: string;                                      // pad "names" can be alphanumeric
  type: 'smd' | 'thru_hole' | 'np_thru_hole';
  shape: 'circle' | 'rect' | 'oval' | 'roundrect' | 'custom';
  at: { x: number; y: number; rotDeg: number }; size: { w: number; h: number };
  drill?: number; layers: string[];
  netId?: number;                                      // absent ⇒ unconnected pad
  pinFunction?: string; pinType?: string;              // present only if board was synced
}

/** Via geometry — at, size, drill, layers, netId */
export interface Via {
  at: Vec2;
  sizeMm: number;
  drillMm: number;
  layers: string[];
  netId?: number;
}

/** Filled copper zone */
export interface Zone {
  netId?: number;
  layer: string;
  polygon: Vec2[][];   // outer + holes
}

/** Silkscreen text item */
export interface BoardText {
  text: string;
  at: { x: number; y: number; rotDeg: number };
  layer: string;
}

/** 3D model XYZ helper */
export interface Xyz {
  x: number;
  y: number;
  z: number;
}
