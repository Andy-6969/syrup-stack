// food-picture-01 entry: writes the picture to /output/entry.png (MAKEFUN_OUTPUT_DIR outside the grader).
//
// The picture is entry.png beside this file, a stack of pancakes with maple syrup, butter and berries,
// ray-marched from signed distance fields by tools/render.mjs (node tools/render.mjs rebuilds it).
// Node 22, standard library only; copying a fixed file makes both runs write the same bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const img = readFileSync(new URL('./entry.png', import.meta.url));
// the gate takes a whole PNG or JPEG of at most 1 MiB: fail loudly here rather than at the gate
const isPng = img.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
const isJpeg = img[0] === 0xff && img[1] === 0xd8 && img[img.length - 2] === 0xff && img[img.length - 1] === 0xd9;
if (!isPng && !isJpeg) throw new Error('entry.png is neither a whole PNG nor a whole JPEG');
if (img.length > 1048576) throw new Error(`entry.png is ${img.length} bytes, over 1 MiB`);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
writeFileSync(join(outDir, 'entry.png'), img);
