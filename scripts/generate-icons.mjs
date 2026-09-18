/**
 * Generates the app's PWA icons from the sigil: the emblem kept intact, centred
 * on the app's own background colour. Run once (and whenever the sigil changes):
 *
 *   node scripts/generate-icons.mjs
 *
 * Outputs the plain (non-maskable) 192/512 manifest icons and the 180px
 * apple-touch-icon into `public/`.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public', 'assets', 'sigil.svg');
const iconsDir = path.join(root, 'public', 'icons');
const background = { r: 7, g: 6, b: 15, alpha: 1 };

async function renderIcon(size, outputPath) {
  // Rasterise the vector at the target size (density keeps the edges crisp) and
  // centre it on a flat background canvas, leaving a small even margin.
  const inner = Math.round(size * 0.82);
  const sigil = await sharp(source, { density: Math.ceil(72 * (size / 64)) })
    .resize(inner, inner)
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: sigil, gravity: 'centre' }])
    .png()
    .toFile(outputPath);
}

await mkdir(iconsDir, { recursive: true });
await renderIcon(192, path.join(iconsDir, 'app-192.png'));
await renderIcon(512, path.join(iconsDir, 'app-512.png'));
await renderIcon(180, path.join(root, 'public', 'apple-touch-icon.png'));
