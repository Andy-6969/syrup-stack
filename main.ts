// food-picture-01 entry: writes the picture to /output/entry.png (MAKEFUN_OUTPUT_DIR outside the grader).
//
// The picture is entry.png beside this file, a stack of pancakes with maple syrup, butter and berries,
// ray-marched from signed distance fields by tools/render.mjs (node tools/render.mjs rebuilds it).
// Node 22, standard library only; copying a fixed file makes both runs write the same bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const png = readFileSync(new URL('./entry.png', import.meta.url));
// the gate takes a whole PNG of at most 1 MiB and 1024 x 1024 pixels: fail loudly here rather than at the gate
const signature = '89504e470d0a1a0a';
if (png.subarray(0, 8).toString('hex') !== signature) throw new Error('entry.png is not a PNG');
if (png.length > 1048576) throw new Error(`entry.png is ${png.length} bytes, over 1 MiB`);
if (png.readUInt32BE(16) > 1024 || png.readUInt32BE(20) > 1024) throw new Error('entry.png is larger than 1024 x 1024');

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
writeFileSync(join(outDir, 'entry.png'), png);
