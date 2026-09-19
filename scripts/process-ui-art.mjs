#!/usr/bin/env node
/** 手工编写的 UI 美术资源。通过 `bun run art:ui` 重新构建；无外部依赖，亦未采用图像生成模型。 */
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const size = 256;
const svg = (body, width = 192, height = width) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;

// 每条边缘在中间 96px 内保持恒定。所有装饰均位于
// 48px 的边角单元格内：border-image 可以在拉伸边缘的同时避免宝石变形。
function frame({ light, mid, dark, gem, ornate }) {
  const corner = ornate
    ? `<path d="M5 43V18L18 5H43V10H22L10 22V43Z" fill="url(#metal)" stroke="${dark}"/>
       <path d="M9 37V20L20 9H37M13 34V23L23 13H34" fill="none" stroke="${light}" stroke-width=".7"/>
       <path d="M8 8L22 13L30 6L28 21L39 26L25 28L20 40L15 25L5 22L14 17Z" fill="${dark}" stroke="${mid}" stroke-width=".9"/>
       <path d="M10 10L23 17L18 24Z M23 17L28 10L26 23L34 26L24 26L20 33L18 24Z" fill="url(#metal)"/>
       <path d="M20 14L26 20L20 27L14 20Z" fill="${dark}" stroke="${light}" stroke-width=".8"/>
       <path d="M20 16L24 20L20 25L16 20Z" fill="url(#gem)"/>
       <path d="M20 16L20 21L16 20Z" fill="${light}" opacity=".75"/>
       <path d="M35 13L43 13M13 35V43M31 31L36 36M32 36L36 32" stroke="${mid}" stroke-width=".8"/>
       <circle cx="39" cy="7" r="1.4" fill="${light}"/><circle cx="7" cy="39" r="1.4" fill="${light}"/>`
    : `<path d="M4 30V12L12 4H30V8H15L8 15V30Z" fill="url(#metal)" stroke="${dark}"/>
       <path d="M7 25V14L14 7H25" fill="none" stroke="${light}" stroke-width=".6"/>
       <path d="M14 10L19 15L14 20L9 15Z" fill="${dark}" stroke="${mid}"/>
       <path d="M14 12L17 15L14 18L11 15Z" fill="url(#gem)"/>
       <path d="M25 11H37M11 25V37" stroke="${mid}" stroke-width=".7"/>`;
  return svg(`<defs>
    <linearGradient id="metal" x2=".7" y2="1"><stop stop-color="${light}"/><stop offset=".28" stop-color="${mid}"/><stop offset=".55" stop-color="${dark}"/><stop offset=".72" stop-color="${mid}"/><stop offset="1" stop-color="${light}"/></linearGradient>
    <linearGradient id="gem" x2=".8" y2="1"><stop stop-color="${gem}"/><stop offset="1" stop-color="${dark}"/></linearGradient>
    <g id="corner">${corner}</g>
  </defs>
  <path d="M18 4H174L188 18V174L174 188H18L4 174V18Z" fill="none" stroke="#06080f" stroke-width="7"/>
  <path d="M18 4H174L188 18V174L174 188H18L4 174V18Z" fill="none" stroke="${mid}" stroke-width="3"/>
  <path d="M18 3H174L189 18V174L174 189H18L3 174V18Z" fill="none" stroke="${light}" stroke-width=".65" opacity=".8"/>
  <path d="M20 8H172L184 20V172L172 184H20L8 172V20Z" fill="none" stroke="${dark}" stroke-width="2"/>
  <path d="M22 11H170L181 22V170L170 181H22L11 170V22Z" fill="none" stroke="${mid}" stroke-width=".7" opacity=".65"/>
  <use href="#corner"/><use href="#corner" transform="translate(192 0) scale(-1 1)"/>
  <use href="#corner" transform="translate(0 192) scale(1 -1)"/><use href="#corner" transform="translate(192 192) scale(-1 -1)"/>`);
}

const frames = {
  'frame-panel.svg': frame({
    light: '#e0c995',
    mid: '#95815a',
    dark: '#302c32',
    gem: '#bec5ef',
    ornate: true,
  }),
  'frame-inset.svg': frame({
    light: '#b1adbc',
    mid: '#666477',
    dark: '#242431',
    gem: '#9d9ab4',
    ornate: false,
  }),
  'frame-control.svg': frame({
    light: '#c9b899',
    mid: '#827154',
    dark: '#302c35',
    gem: '#a0a8ce',
    ornate: false,
  }),
  'frame-accent.svg': frame({
    light: '#ffe0a5',
    mid: '#bd9356',
    dark: '#453526',
    gem: '#fae2a5',
    ornate: true,
  }),
  'chevron.svg': svg(
    '<path d="M3 5L9 11L15 5" fill="none" stroke="#e5c68e" stroke-width="1.5"/><path d="M6 4L9 7L12 4" fill="none" stroke="#8b7959" stroke-width=".8"/>',
    18,
    16,
  ),
  'divider.svg': svg(
    `<defs><linearGradient id="fade"><stop stop-color="#a88b56" stop-opacity="0"/><stop offset=".3" stop-color="#a88b56"/><stop offset=".7" stop-color="#a88b56"/><stop offset="1" stop-color="#a88b56" stop-opacity="0"/></linearGradient></defs><path d="M0 12H143M177 12H320" stroke="url(#fade)"/><path d="M134 12L145 9L150 12L145 15Z M186 12L175 9L170 12L175 15Z" fill="#8c7956"/><path d="M160 3L169 12L160 21L151 12Z" fill="#171725" stroke="#b9a477"/><path d="M160 7L164 12L160 17L156 12Z" fill="#bbb1d8"/><path d="M153 2L160 0L167 2M153 22L160 24L167 22" fill="none" stroke="#68583e"/>`,
    320,
    24,
  ),
  'seal.svg': svg(
    `<defs><radialGradient id="enamel"><stop stop-color="#393b59"/><stop offset="1" stop-color="#131422"/></radialGradient><linearGradient id="gold" x2="1" y2="1"><stop stop-color="#ecd4a0"/><stop offset=".5" stop-color="#7b674a"/><stop offset="1" stop-color="#c6ac75"/></linearGradient></defs><path d="M48 2L60 12L75 10L81 25L94 34L90 49L94 64L80 73L74 88L59 86L48 96L36 85L21 88L15 73L2 64L6 49L2 34L16 25L22 10L37 12Z" fill="#10121d" stroke="url(#gold)" stroke-width="2"/><circle cx="48" cy="49" r="33" fill="url(#enamel)" stroke="url(#gold)" stroke-width="3"/><circle cx="48" cy="49" r="28" fill="none" stroke="#8c7b5b" stroke-width=".7"/><path d="M48 22L65 49L48 77L31 49Z" fill="none" stroke="url(#gold)" stroke-width="2"/><path d="M48 34L57 49L48 64L39 49Z" fill="#c4bdde"/><path d="M48 34V49H39Z" fill="#f5e7bc"/><path d="M20 49H26M70 49H76M48 16V21M48 77V82" stroke="#e0c68d"/><circle cx="48" cy="8" r="2" fill="#e0c68d"/><circle cx="48" cy="90" r="2" fill="#e0c68d"/>`,
    96,
    98,
  ),
};

// 在环面上采样的周期性值噪声（Value Noise）。整数网格频率使
// 贴图在两个轴向上均实现无缝连续；末端像素自然衔接至起始像素。
function noise(x, y, frequency, seed) {
  const px = (x / size) * frequency;
  const py = (y / size) * frequency;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const smooth = (n) => n * n * (3 - 2 * n);
  const tx = smooth(px - ix);
  const ty = smooth(py - iy);
  const value = (gx, gy) => {
    let hash =
      Math.imul((gx % frequency) + seed, 374761393) ^ Math.imul((gy % frequency) + seed, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295 - 0.5;
  };
  const top = value(ix, iy) * (1 - tx) + value(ix + 1, iy) * tx;
  const bottom = value(ix, iy + 1) * (1 - tx) + value(ix + 1, iy + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

async function material(name, base, seed) {
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain = noise(x, y, 128, seed) * 5 + noise(x, y, 32, seed + 7) * 5;
      const cloud = noise(x, y, 4, seed + 3) * 6 + noise(x, y, 16, seed + 4) * 4;
      const fiber =
        name === 'vellum' ? Math.sin((y * Math.PI) / 2 + noise(x, y, 8, seed) * 2) * 1.5 : 0;
      const pores = name === 'leather' ? -Math.abs(noise(x, y, 64, seed + 11)) * 9 : 0;
      for (let channel = 0; channel < 3; channel++) {
        pixels[(y * size + x) * 3 + channel] = Math.round(
          base[channel] + grain + cloud + fiber + pores,
        );
      }
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer();
}

export async function processUiArt(outDir = path.join(root, 'public/assets'), dryRun = false) {
  const output = path.join(outDir, 'ui');
  const files = Object.entries(frames).map(([name, content]) => ({
    name,
    data: Buffer.from(content),
    vector: true,
  }));
  for (const { name, base, seed } of [
    { name: 'leather', base: [23, 24, 37], seed: 31 },
    { name: 'vellum', base: [38, 33, 34], seed: 71 },
    { name: 'stone', base: [17, 22, 30], seed: 113 },
  ]) {
    files.push({ name: `${name}.webp`, data: await material(name, base, seed), vector: false });
  }
  if (!dryRun) await mkdir(output, { recursive: true });
  const entries = [];
  for (const file of files) {
    if (!dryRun) await writeFile(path.join(output, file.name), file.data);
    const meta = await sharp(file.data).metadata();
    entries.push({
      path: `public/assets/ui/${file.name}`,
      kind: file.vector ? 'ui-ornament' : 'ui-material',
      origin: 'hand-authored',
      method: file.vector
        ? 'Original SVG metalwork, fixed-corner nine-slice frames and decorative ornaments'
        : 'Original deterministic periodic material synthesis; lossless WebP',
      tool: 'scripts/process-ui-art.mjs; sharp/libvips',
      model: null,
      dimensions: `${meta.width}x${meta.height}`,
      bytes: file.data.length,
      usage: file.name.startsWith('frame-')
        ? 'CSS border-image: 48 source pixels per corner; repeat stretch; center transparent. Minimum supported box 48x32 CSS pixels.'
        : file.vector
          ? 'Decorative background artwork; no semantic content.'
          : 'Seamless dark material: repeat at 256x256 CSS pixels; never scale to container dimensions.',
    });
  }
  const provenancePath = path.join(outDir, 'provenance.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  provenance.note = provenance.note.replace(
    'or an explicitly hand-authored SVG',
    'or explicitly hand-authored vector/procedural artwork',
  );
  provenance.entries = [
    ...provenance.entries.filter((entry) => !entry.path.startsWith('public/assets/ui/')),
    ...entries,
  ];
  provenance.ui = {
    script: 'scripts/process-ui-art.mjs',
    origin: 'hand-authored',
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    frameSlice: 48,
    tileSize: size,
  };
  const note =
    ' UI artwork is separately hand-authored SVG metalwork and deterministic periodic raster materials, reproduced by scripts/process-ui-art.mjs; not image-model output.';
  if (!provenance.note.includes('UI artwork is separately')) provenance.note += note;
  if (!dryRun) await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(
    `${dryRun ? 'Would write' : 'Wrote'} ${entries.length} UI assets: ${(provenance.ui.bytes / 1024).toFixed(1)} KiB`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await processUiArt();
