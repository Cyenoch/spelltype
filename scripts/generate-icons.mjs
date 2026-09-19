/**
 * 从印记（sigil）矢量图生成应用的 PWA 图标：保持徽标完整，居中置于应用自身的背景色上。
 * 执行一次（以及在印记变更时执行）：
 *
 *   node scripts/generate-icons.mjs
 *
 * 将常规（非可覆罩/non-maskable）的 192/512 manifest 图标及 180px 的
 * apple-touch-icon 输出到 `public/` 目录下。
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
  // 按目标尺寸光栅化矢量图（通过调整 density 保持边缘清晰锐利），
  // 并将其居中置于纯色背景画布上，四周保留微小且均匀的边距。
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
