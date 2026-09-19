#!/usr/bin/env node
/**
 * Spelltype 美术资源处理脚本。
 *
 * 将生成的对局原始素材（四张竞技场背景图、一张角色精灵图表、一张法术图标图集，
 * 以及每个元素一张特效图表）转换并输出为 src/pixi/assets.ts 所引用的确切文件，
 * 并根据本次运行测得的数据重写 public/assets/provenance.json。
 * 处理流程具有确定性：相同的输入字节始终生成相同的输出字节，
 * 且报告中的每个尺寸与字节数均从已写入的文件中重新读取。
 *
 * 用法：
 *   node scripts/process-art.mjs --source-dir .scratch/artdrop-final
 *
 * 选项：
 *   --source-dir <dir>  存放生成原图的目录（处理时必需）
 *   --out-dir <dir>     输出目标资源根目录（默认：public/assets）
 *   --only <steps>      指定执行的子步骤：arenas,icons,characters,vfx,background,portraits,provenance,check
 *   --superseded <text> 明确废弃且不发布的生成记录；
 *                       默认使用 provenance.json 中现存的记录，以在日常重新运行时保留历史
 *   --dry-run           仅报告将要写入的内容，不写入磁盘
 *
 * 每份原始素材必须携带真实透明通道（直接保留其 Alpha 通道），
 * 或为暗色背景下的发光特效（根据亮度派生 Alpha 通道）。
 * 严禁臆断猜测，不符合要求的素材将被拒绝。通过测量所得的几何尺寸进行素材校验，而非依据文件大小。
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processUiArt } from './process-ui-art.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(REPO_ROOT, 'src/pixi/assets.ts');
const ELEMENTS = ['arcane', 'fire', 'ice', 'storm'];
const ALL_STEPS = [
  'arenas',
  'icons',
  'characters',
  'vfx',
  'background',
  'portraits',
  'provenance',
  'ui',
  'check',
];

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const [name, inline] = token.slice(2).split('=');
    if (name === 'dry-run') {
      flags.set(name, true);
      continue;
    }
    if (!['source-dir', 'out-dir', 'only', 'superseded'].includes(name))
      throw new Error(`unknown option --${name}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, value);
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(flags.get('out-dir') ?? path.join(REPO_ROOT, 'public/assets'));
const SOURCE_DIR = flags.get('source-dir') ? path.resolve(flags.get('source-dir')) : null;
const DRY_RUN = flags.get('dry-run') === true;
const steps = (flags.get('only') ?? ALL_STEPS.join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
for (const step of steps) {
  if (!ALL_STEPS.includes(step))
    throw new Error(`unknown step "${step}" (expected one of ${ALL_STEPS.join(', ')})`);
}
if (!SOURCE_DIR && steps.some((step) => step !== 'check')) {
  throw new Error('--source-dir is required to process artwork');
}

const PROVENANCE_PATH = path.join(OUT_DIR, 'provenance.json');
const previousProvenance = await readFile(PROVENANCE_PATH, 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => null);
const SUPERSEDED = flags.has('superseded')
  ? [flags.get('superseded')]
  : (previousProvenance?.summary?.supersededGenerations ?? []);

// ------------------------------------------------------------------ 报告与统计 ---

const report = [];
const cutouts = {};

const log = (message) => process.stdout.write(`${message}\n`);
const relativePath = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

async function emit(relative, buffer, meta) {
  if (!DRY_RUN) {
    const absolute = path.join(OUT_DIR, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);
  }
  const entry = {
    path: `public/assets/${relative.split(path.sep).join('/')}`,
    bytes: buffer.length,
    ...meta,
  };
  report.push(entry);
  log(
    `  ${entry.path.padEnd(42)} ${String(meta.width).padStart(4)}x${String(meta.height).padEnd(4)} ${(buffer.length / 1024).toFixed(1).padStart(7)} KiB`,
  );
  return entry;
}

/** 获取生成素材的字节大小与 sha256，用于在出处（provenance）清单中精确定位。 */
async function fingerprint(file) {
  const bytes = await readFile(file);
  return {
    sourceBytes: bytes.length,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function fileExists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function assertGeometry(meta, file, { cols = 1, rows = 1, minCell = 200, square = false }) {
  const where = relativePath(file);
  if (meta.width < cols * minCell || meta.height < rows * minCell) {
    throw new Error(
      `${where} is ${meta.width}x${meta.height}: expected at least ${cols * minCell}x${rows * minCell} for a ${cols}x${rows} grid`,
    );
  }
  if (square) {
    const aspect = meta.width / meta.height;
    if (Math.abs(aspect - 1) > 0.15) {
      throw new Error(
        `${where} is ${meta.width}x${meta.height}: a ${cols}x${rows} cell grid must be close to square`,
      );
    }
  }
}

// ------------------------------------------------------------------- 像素处理 ---

async function readRaw(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, source: path.basename(file) };
}

const asSharp = (img) =>
  sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });

function alphaProfile(img, threshold = 16) {
  const { data, width, height } = img;
  const n = width * height;
  let clear = 0;
  let solid = 0;
  for (let p = 0; p < n; p++) {
    const alpha = data[p * 4 + 3];
    if (alpha < threshold) clear++;
    else if (alpha > 255 - threshold) solid++;
  }
  return { clear: clear / n, solid: solid / n };
}

/** 计算图表四个边角的平均亮度：用于衡量纯色背景的亮度。 */
function cornerLuma({ data, width, height }) {
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  let sum = 0;
  for (const p of corners) {
    const i = p * 4;
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / corners.length;
}

/**
 * 确定如何将生成图表的背景转换为透明通道（Alpha），绝不凭空臆断：
 *  - 已包含真实透明通道的图表直接保留原通道；
 *  - 暗色背景上的发光特效素材根据亮度计算透明度；
 *  - 其他情况一律拒绝处理，因为盲目推测抠像基准色会导致同色前景被错误剔除。
 */
function prepareSheet(sheet, label) {
  const profile = alphaProfile(sheet);
  if (profile.clear > 0.05 && profile.solid > 0.05) {
    log(
      `  ${label}: already carries alpha (${(profile.clear * 100).toFixed(1)}% clear, ${(profile.solid * 100).toFixed(1)}% solid) — kept verbatim`,
    );
    return { img: bleedEdgeColors(sheet), mode: 'existing-alpha', profile };
  }
  const luma = cornerLuma(sheet);
  if (luma < 60) {
    log(
      `  ${label}: glow art on a dark backdrop (corner luma ${luma.toFixed(0)}/255) — alpha derived from luminance`,
    );
    return { img: bleedEdgeColors(luminanceToAlpha(sheet)), mode: 'luminance', profile };
  }
  throw new Error(
    `${label}: no alpha channel and a bright backdrop (corner luma ${luma.toFixed(0)}/255); ` +
      'regenerate it with a transparent or dark backdrop instead of relying on a guessed key colour',
  );
}

/** 根据亮度直接计算透明通道（Straight-Alpha），并将颜色通道反向去预乘。 */
function luminanceToAlpha(img, floor = 14, ceil = 150) {
  const { data, width, height } = img;
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    let alpha = Math.round(((Math.max(r, g, b) - floor) / (ceil - floor)) * 255);
    alpha = Math.max(0, Math.min(255, alpha));
    if (alpha < 10) alpha = 0;
    if (alpha === 255) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    } else if (alpha > 0) {
      const a = alpha / 255;
      out[i] = Math.min(255, Math.round(r / a));
      out[i + 1] = Math.min(255, Math.round(g / a));
      out[i + 2] = Math.min(255, Math.round(b / a));
    }
    out[i + 3] = alpha;
  }
  return { data: out, width, height };
}

/**
 * 将不透明颜色向外扩散至透明像素（最近邻采样）。
 * 调色板 PNG 编码会忽略 Alpha 权衡颜色，且非预乘 GPU 采样易产生光晕边，
 * 因此透明像素中绝不能残留抠像底色。
 */
function bleedEdgeColors(img, maxSteps = 28) {
  const { data, width, height } = img;
  const n = width * height;
  const out = Buffer.from(data);
  const step = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) {
    if (data[p * 4 + 3] > 8) {
      step[p] = 0;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const current = step[p];
    if (current >= maxSteps) continue;
    const x = p % width;
    const y = (p - x) / width;
    const i = p * 4;
    const visit = (q) => {
      if (step[q] !== -1) return;
      step[q] = current + 1;
      out[q * 4] = out[i];
      out[q * 4 + 1] = out[i + 1];
      out[q * 4 + 2] = out[i + 2];
      queue[tail++] = q;
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }
  return { data: out, width, height };
}

function alphaBounds(img, threshold = 6) {
  const { data, width, height } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0
    ? null
    : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ------------------------------------------------------------------- 图表切分 ---
//
/** 均等网格切分，切分边界吸附至最空旷的间隙行列。 */
function splitCells(img, cols, rows) {
  const { data, width, height } = img;
  const columnHits = new Int32Array(width);
  const rowHits = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        columnHits[x]++;
        rowHits[y]++;
      }
    }
  }
  const snap = (hits, size, cuts) => {
    const slack = Math.max(2, Math.round(size * 0.04));
    const bounds = [0];
    for (let c = 1; c < cuts; c++) {
      const ideal = Math.round((size * c) / cuts);
      let best = ideal;
      let fewest = Infinity;
      for (let d = -slack; d <= slack; d++) {
        const index = ideal + d;
        if (index <= bounds[bounds.length - 1] + 4 || index >= size - 2) continue;
        if (hits[index] < fewest) {
          fewest = hits[index];
          best = index;
        }
      }
      bounds.push(best);
    }
    bounds.push(size);
    return bounds;
  };
  const xs = snap(columnHits, width, cols);
  const ys = snap(rowHits, height, rows);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = xs[c];
      const top = ys[r];
      const cellWidth = xs[c + 1] - left;
      const cellHeight = ys[r + 1] - top;
      const cell = {
        data: Buffer.alloc(cellWidth * cellHeight * 4),
        width: cellWidth,
        height: cellHeight,
      };
      for (let y = 0; y < cellHeight; y++) {
        data.copy(
          cell.data,
          y * cellWidth * 4,
          ((top + y) * width + left) * 4,
          ((top + y) * width + left + cellWidth) * 4,
        );
      }
      cells.push(cell);
    }
  }
  return cells;
}

/** 裁切至可见主体并留出缓冲边距，裁切范围不超出图表边缘。 */
async function trimWithPad(img, padRatio) {
  const bounds = alphaBounds(img);
  if (!bounds) throw new Error(`no opaque pixels found in ${img.source ?? 'image'}`);
  const pad = Math.round(Math.max(bounds.width, bounds.height) * padRatio);
  const left = Math.max(0, bounds.left - pad);
  const top = Math.max(0, bounds.top - pad);
  const right = Math.min(img.width, bounds.left + bounds.width + pad);
  const bottom = Math.min(img.height, bounds.top + bounds.height + pad);
  const cropped = await asSharp(img)
    .extract({ left, top, width: right - left, height: bottom - top })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: cropped.data,
    width: cropped.info.width,
    height: cropped.info.height,
    source: img.source,
  };
}

/** 解析、校验并解码单张网格图表素材。 */
async function loadSheet(fileName, cols, rows) {
  const file = path.join(SOURCE_DIR, fileName);
  if (!(await fileExists(file))) {
    log(`  ${fileName}: not in the source directory`);
    return null;
  }
  const meta = await sharp(file).metadata();
  assertGeometry(meta, file, { cols, rows, minCell: 200, square: true });
  const sheet = await readRaw(file);
  log(`  ${fileName}: ${sheet.width}x${sheet.height}, ${cols}x${rows} cells`);
  return { file, meta, sheet, fingerprint: await fingerprint(file) };
}

// -------------------------------------------------------------------- 处理步骤 ---

async function processArenas() {
  for (let slot = 0; slot < ELEMENTS.length; slot++) {
    const file = path.join(SOURCE_DIR, `arena-${slot + 1}.png`);
    if (!(await fileExists(file))) {
      log(`  arena ${slot + 1}: ${path.basename(file)} is not in the source directory`);
      continue;
    }
    const meta = await sharp(file).metadata();
    if (meta.hasAlpha)
      throw new Error(
        `${relativePath(file)} has an alpha channel: an arena master must be an opaque backdrop`,
      );
    if (meta.width < 1200 || meta.height < 600) {
      throw new Error(
        `${relativePath(file)} is ${meta.width}x${meta.height}: too small for an arena backdrop (need at least 1200x600)`,
      );
    }
    if (Math.abs(meta.width / meta.height - 16 / 9) / (16 / 9) > 0.25) {
      throw new Error(
        `${relativePath(file)} is ${meta.width}x${meta.height}: not a landscape 16:9-ish arena backdrop`,
      );
    }
    // 绝不放大尺寸：withoutEnlargement 保持 1672x941 原素材尺寸不变，
    // 同时能将超大素材等比缩放至 1920x1080 范围以内。
    const buffer = await sharp(file)
      .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 6, smartSubsample: true })
      .toBuffer();
    const written = await sharp(buffer).metadata();
    await emit(`arenas/arena-${slot + 1}.webp`, buffer, {
      kind: 'arena',
      source: relativePath(file),
      sourceDimensions: `${meta.width}x${meta.height}`,
      ...(await fingerprint(file)),
      processing:
        written.width === meta.width && written.height === meta.height
          ? 'generated master kept at native pixel dimensions (no resampling), encoded WebP q78 effort 6'
          : `generated master downscaled with sharp/libvips from ${meta.width}x${meta.height} into 1920x1080, encoded WebP q78 effort 6`,
      width: written.width,
      height: written.height,
    });
  }
}

async function processIcons() {
  const loaded = await loadSheet('spell-icons-sheet.png', 4, 4);
  if (!loaded) return;
  const prepared = prepareSheet(loaded.sheet, 'icons');
  cutouts.icons = { mode: prepared.mode, ...prepared.profile };
  const cells = splitCells(prepared.img, 4, 4);
  for (let index = 0; index < 16; index++) {
    const element = ELEMENTS[Math.floor(index / 4)];
    const cell = await trimWithPad(cells[index], 0.06);
    const buffer = await asSharp(cell)
      .resize({
        width: 256,
        height: 256,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 88, effort: 6, alphaQuality: 92 })
      .toBuffer();
    await emit(`spells/${element}-${(index % 4) + 1}.webp`, buffer, {
      kind: 'spell-icon',
      element,
      source: relativePath(loaded.file),
      sourceDimensions: `${loaded.sheet.width}x${loaded.sheet.height}`,
      ...loaded.fingerprint,
      processing:
        '4x4 cell split on the alpha mask, trim to glyph + 6% padding, 256x256 contain, WebP q88 with alpha',
      width: 256,
      height: 256,
    });
  }
}

async function processCharacters() {
  const loaded = await loadSheet('characters-sheet.png', 2, 2);
  if (!loaded) return;
  const prepared = prepareSheet(loaded.sheet, 'characters');
  cutouts.characters = { mode: prepared.mode, ...prepared.profile };
  const cells = splitCells(prepared.img, 2, 2);
  for (let slot = 0; slot < 4; slot++) {
    const element = ELEMENTS[slot];
    const cell = await trimWithPad(cells[slot], 0.03);
    const buffer = await asSharp(cell)
      .resize({ width: 768, height: 1024, fit: 'inside' })
      .webp({ quality: 92, alphaQuality: 95, effort: 6, smartSubsample: true })
      .toBuffer();
    const written = await sharp(buffer).metadata();
    await emit(`characters/slot-${slot}-${element}.webp`, buffer, {
      kind: 'character',
      element,
      slot,
      source: relativePath(loaded.file),
      sourceDimensions: `${loaded.sheet.width}x${loaded.sheet.height}`,
      ...loaded.fingerprint,
      processing:
        '2x2 cell split on the alpha mask, trim to figure + 3% padding, fit within 768x1024, WebP q92 with alpha',
      width: written.width,
      height: written.height,
    });
  }
}

async function processVfx() {
  for (const element of ELEMENTS) {
    const loaded = await loadSheet(`vfx-${element}-sheet.png`, 2, 2);
    if (!loaded) continue;
    const prepared = prepareSheet(loaded.sheet, `vfx-${element}`);
    cutouts[`vfx-${element}`] = { mode: prepared.mode, ...prepared.profile };
    const cells = splitCells(prepared.img, 2, 2);
    for (let index = 0; index < 4; index++) {
      const cell = await trimWithPad(cells[index], 0.04);
      const buffer = await asSharp(cell)
        .resize({
          width: 512,
          height: 512,
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality: 92, alphaQuality: 100, effort: 6, smartSubsample: true })
        .toBuffer();
      const written = await sharp(buffer).metadata();
      await emit(`combat-fx/${element}-${index + 1}.webp`, buffer, {
        kind: 'combat-fx',
        element,
        source: relativePath(loaded.file),
        sourceDimensions: `${loaded.sheet.width}x${loaded.sheet.height}`,
        ...loaded.fingerprint,
        processing:
          '2x2 cell split on the alpha mask, trim to effect + 4% padding, 512x512 contain, WebP q92 with exact alpha',
        width: written.width,
        height: written.height,
      });
    }
  }
}

/**
 * 既有的生成页面背景图，与其他位图一样输出为 WebP 格式。
 * 其 JPEG 原素材与其他生成资源一同存放，此处仅重新编码，不进行重采样或编辑。
 */
async function processBackground() {
  const file = path.join(SOURCE_DIR, 'academy-hall.jpg');
  if (!(await fileExists(file))) {
    log('  skipped, academy-hall.jpg is not in the source directory');
    return;
  }
  const meta = await sharp(file).metadata();
  if (meta.hasAlpha)
    throw new Error(`${relativePath(file)} has an alpha channel: a backdrop master must be opaque`);
  if (meta.width < 1200 || meta.height < 600) {
    throw new Error(
      `${relativePath(file)} is ${meta.width}x${meta.height}: too small for a page backdrop (need at least 1200x600)`,
    );
  }
  const buffer = await sharp(file).webp({ quality: 80, smartSubsample: true }).toBuffer();
  const written = await sharp(buffer).metadata();
  await emit('bg/academy-hall.webp', buffer, {
    kind: 'background',
    source: relativePath(file),
    sourceDimensions: `${meta.width}x${meta.height}`,
    ...(await fingerprint(file)),
    processing: `pre-existing generated JPEG master re-encoded to WebP q80 with sharp/libvips (no resampling, kept at native ${written.width}x${written.height})`,
    width: written.width,
    height: written.height,
  });
}

/**
 * 512x512 大厅头像：从派生的角色全身图中裁切，
 * 并叠加在 sharp 根据 SVG 源码字符串渲染出的元素着色渐变背景之上。
 */
async function processPortraits() {
  const tints = {
    arcane: { r: 60, g: 40, b: 120 },
    fire: { r: 120, g: 46, b: 26 },
    ice: { r: 28, g: 74, b: 118 },
    storm: { r: 92, g: 72, b: 30 },
  };
  for (let slot = 0; slot < 4; slot++) {
    const element = ELEMENTS[slot];
    const characterPath = path.join(OUT_DIR, `characters/slot-${slot}-${element}.webp`);
    if (!(await fileExists(characterPath))) {
      log(
        `  portrait ${slot + 1}: skipped, run the characters step first (${relativePath(characterPath)} is missing)`,
      );
      continue;
    }
    const { data, info } = await sharp(characterPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const body = { data, width: info.width, height: info.height };
    const bounds = alphaBounds(body) ?? { left: 0, top: 0, width: body.width, height: body.height };
    const side = Math.max(
      8,
      Math.min(
        Math.round(Math.min(bounds.width * 1.5, bounds.height * 0.5)),
        body.width,
        body.height,
      ),
    );
    const left = Math.max(
      0,
      Math.min(body.width - side, Math.round(bounds.left + bounds.width / 2 - side / 2)),
    );
    const top = Math.max(0, Math.min(body.height - side, bounds.top - Math.round(side * 0.06)));
    const crop = await asSharp(body)
      .extract({ left, top, width: side, height: side })
      .resize(512, 512, { fit: 'cover' })
      .png()
      .toBuffer();

    const tint = tints[element];
    const backdrop = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
         <defs>
           <radialGradient id="g" cx="50%" cy="34%" r="78%">
             <stop offset="0%" stop-color="rgb(${Math.round(tint.r * 1.5)},${Math.round(tint.g * 1.5)},${Math.round(tint.b * 1.5)})"/>
             <stop offset="62%" stop-color="rgb(${Math.round(tint.r * 0.55)},${Math.round(tint.g * 0.55)},${Math.round(tint.b * 0.6)})"/>
             <stop offset="100%" stop-color="#0d0a1c"/>
           </radialGradient>
         </defs>
         <rect width="512" height="512" fill="url(#g)"/>
       </svg>`,
    );
    const buffer = await sharp(backdrop)
      .composite([{ input: crop, blend: 'over' }])
      .webp({ quality: 84, smartSubsample: true })
      .toBuffer();
    await emit(`avatars/seat-${slot + 1}.webp`, buffer, {
      kind: 'portrait',
      element,
      slot,
      source: `public/assets/characters/slot-${slot}-${element}.webp`,
      sourceDimensions: `${body.width}x${body.height}`,
      processing:
        'square head-and-shoulders crop around the measured alpha bounds of the derived full-body character, 512x512, composited over an element-tinted radial gradient (SVG rendered by sharp), WebP q84',
      width: 512,
      height: 512,
    });
  }
}

// -------------------------------------------------------------- 出处（provenance）清单 ---

const HAND_AUTHORED = [
  {
    path: 'public/assets/bg/academy.svg',
    kind: 'background-vector-fallback',
    origin: 'hand-authored',
    method: 'hand-authored SVG',
    tool: 'text editor',
    model: null,
    dimensions: '1600x900',
    usage:
      'Vector fallback for the backdrop if the bitmap fails to load. Authored markup, never described as generated.',
  },
  ...ELEMENTS.map((element) => ({
    path: `public/assets/elements/${element}.svg`,
    kind: 'element-glyph',
    origin: 'hand-authored',
    method: 'hand-authored SVG',
    tool: 'text editor',
    model: null,
    dimensions: '64x64',
    usage: `Element indicator for '${element}'. Also the always-available fallback when a spell-icon bitmap fails to load.`,
  })),
  ...[1, 2, 3, 4].map((seat) => ({
    path: `public/assets/avatars/seat-${seat}.svg`,
    kind: 'avatar-vector-fallback',
    origin: 'hand-authored',
    method: 'hand-authored SVG',
    tool: 'text editor',
    model: null,
    dimensions: '256x256',
    usage: `onerror fallback for seat-${seat}.webp in lobby seats and results.`,
  })),
  {
    path: 'public/assets/sigil.svg',
    kind: 'icon',
    origin: 'hand-authored',
    method: 'hand-authored SVG',
    tool: 'text editor',
    model: null,
    dimensions: '64x64',
    usage: 'Favicon referenced by index.html and the app mark in the header and boot splash.',
  },
  {
    path: 'public/assets/effects/spark.svg',
    kind: 'particle-texture',
    origin: 'hand-authored',
    method: 'hand-authored SVG',
    tool: 'text editor',
    model: null,
    dimensions: '64x64',
    usage: 'Mote texture for the backdrop particle field.',
  },
];

const USAGE = {
  background: () =>
    'Full-page backdrop: CSS layer plus PIXI texture for the parallax backdrop. Dark magical academy hall; contains no text, logo or watermark.',
  arena: (entry) =>
    `Arena backdrop ${entry.path.match(/arena-(\d)/)?.[1]} of 4, drawn behind the fighters. Painterly dark-fantasy magic-academy hall.`,
  character: (entry) =>
    `Full-body combatant for seat slot ${entry.slot} (${entry.element}), drawn with real alpha in the arena.`,
  'spell-icon': (entry) =>
    `Spell sigil for the ${entry.element} element, cycled by spell index in the typing panel.`,
  'combat-fx': (entry) =>
    `Impact effect for the ${entry.element} element, played over the target when a spell lands.`,
  portrait: (entry) =>
    `Lobby/results portrait for seat ${entry.slot + 1} (${entry.element}), cropped from the derived full-body character.`,
};

const describeCutout = (stats) => {
  if (!stats) return 'no cutout step';
  const shares = `${(stats.clear * 100).toFixed(1)}% fully clear, ${(stats.solid * 100).toFixed(1)}% fully solid`;
  return stats.mode === 'existing-alpha'
    ? `the sheet already carried a real alpha channel (${shares}) — alpha kept verbatim, no keying applied`
    : `alpha derived from luminance of the dark-backdrop sheet (${shares}, floor 14/255, ceil 150/255) with colour un-premultiplied back to straight alpha`;
};

const cutoutFor = (entry) =>
  entry.kind === 'character'
    ? cutouts.characters
    : entry.kind === 'combat-fx'
      ? cutouts[`vfx-${entry.element}`]
      : cutouts.icons;

async function writeProvenance() {
  if (report.length === 0) {
    throw new Error(
      'provenance is written from what this run measured: include the processing steps, not --only provenance',
    );
  }
  const measured = [];
  for (const entry of report) {
    const info = await stat(path.join(REPO_ROOT, entry.path)).catch(() => null);
    const provenanceEntry = {
      path: entry.path,
      kind: entry.kind,
      origin:
        entry.kind === 'arena' || entry.kind === 'background' ? 'generated-source' : 'derived',
      method:
        entry.kind === 'arena' || entry.kind === 'background'
          ? 'generated bitmap, locally transcoded (no synthesis in the pipeline)'
          : 'generated bitmap sheet, locally derived (split / trimmed / resized) — no hand-authored vector art',
      tool: 'session image_gen (via coordinating agent), sharp/libvips',
      model:
        'not exposed to this worker (claimed as: the coordinating agent’s image-gen tool, model name unknown)',
      source: entry.source,
      sourceDimensions: entry.sourceDimensions,
      dimensions: `${entry.width}x${entry.height}`,
      bytes: info?.size ?? entry.bytes,
      processing:
        USAGE[entry.kind] && cutoutFor(entry)
          ? `${describeCutout(cutoutFor(entry))}; then ${entry.processing}`
          : entry.processing,
      usage: USAGE[entry.kind]?.(entry) ?? entry.kind,
    };
    if (entry.element) provenanceEntry.element = entry.element;
    if (entry.slot !== undefined) provenanceEntry.slot = entry.slot;
    if (entry.sourceSha256) {
      provenanceEntry.sourceSha256 = entry.sourceSha256;
      provenanceEntry.sourceBytes = entry.sourceBytes;
    }
    measured.push(provenanceEntry);
  }

  const order = {
    arena: 0,
    background: 1,
    character: 2,
    'spell-icon': 3,
    'combat-fx': 4,
    portrait: 5,
  };
  measured.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
  const portraits = measured.filter((entry) => entry.kind === 'portrait');
  const assets = measured.filter((entry) => entry.kind !== 'portrait');

  // 每个竞技场文件及每个网格图表对应一份生成的原素材；头像从
  // 已发布的角色图中派生，绝不计入新生成的素材统计。
  const masters = new Map();
  for (const entry of measured) {
    if (entry.sourceSha256 && entry.source && !masters.has(entry.source)) {
      masters.set(entry.source, { path: entry.source, sha256: entry.sourceSha256 });
    }
  }
  const generatedSources = [...masters.values()];
  const entries = [...assets, ...portraits, ...HAND_AUTHORED];

  const provenance = {
    note:
      'Asset provenance for the Spelltype frontend. Every shipped bitmap under public/assets/ is either a generated ' +
      'source bitmap that the coordinating agent produced with its image-gen tool, a local derivation (split, trim, ' +
      'bleed, resize, re-encode) of such a bitmap, or explicitly hand-authored vector/procedural artwork labelled "hand-authored" and ' +
      'never described as generated. The image model name is not exposed to this worker, so none is claimed. All ' +
      'processing is local and deterministic and reproducible with scripts/process-art.mjs: sharp/libvips for decode, ' +
      'resize and encode, alpha taken from the masters themselves or derived from luminance for glow art on a dark ' +
      'backdrop, and a sharp-rendered SVG gradient for the portrait backdrops. No external hosting, CDN or remote URL ' +
      `is used. This pass shipped ${measured.length} files (${assets.length} arena/character/icon/effect assets plus ` +
      `${portraits.length} portraits derived from them) out of ${generatedSources.length} unique current masters.` +
      (SUPERSEDED.length > 0
        ? ` Superseded generations, deliberately not shipped: ${SUPERSEDED.join('; ')}.`
        : ''),
    generatedAt: new Date().toISOString().slice(0, 10),
    invocation: {
      script: relativePath(fileURLToPath(import.meta.url)),
      sourceDir: relativePath(SOURCE_DIR ?? REPO_ROOT),
      outDir: relativePath(OUT_DIR),
      steps,
      supersededFlag: SUPERSEDED,
    },
    toolchain: {
      sharp: JSON.parse(
        await readFile(path.join(REPO_ROOT, 'node_modules/sharp/package.json'), 'utf8'),
      ).version,
      libvips: sharp.versions?.vips ?? 'unknown',
      node: process.version,
    },
    summary: {
      uniqueGeneratedSources: generatedSources.length,
      supersededGenerations: SUPERSEDED,
      generatedSources,
      shippedFiles: measured.length,
      background: measured.filter((entry) => entry.kind === 'background').length,
      arenas: measured.filter((entry) => entry.kind === 'arena').length,
      characters: measured.filter((entry) => entry.kind === 'character').length,
      spellIcons: measured.filter((entry) => entry.kind === 'spell-icon').length,
      combatFx: measured.filter((entry) => entry.kind === 'combat-fx').length,
      portraits: portraits.length,
      totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      cutouts: cutouts,
    },
    entries,
  };

  if (!DRY_RUN) await writeFile(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
  log(`  wrote ${relativePath(PROVENANCE_PATH)} with ${entries.length} entries`);
}

/** 资源模块中的每个 URL 字面量都必须能在资源根目录中成功解析。 */
async function checkRegistry() {
  const urls = [
    ...new Set(
      [
        ...`${await readFile(REGISTRY, 'utf8')}\n${await readFile(path.join(REPO_ROOT, 'src/styles.css'), 'utf8')}`.matchAll(
          /'(\/assets\/[^']+)'/g,
        ),
      ].map((match) => match[1]),
    ),
  ].sort();
  const missing = [];
  let totalBytes = 0;
  for (const url of urls) {
    // 校验文件是否存在
    const info = await stat(file).catch(() => null);
    if (!info) {
      missing.push(url);
      log(`    MISSING ${url}`);
      continue;
    }
    totalBytes += info.size;
    const meta = url.endsWith('.svg') ? null : await sharp(file).metadata();
    log(
      `    ok ${url.padEnd(38)} ${meta ? `${meta.width}x${meta.height} ${meta.format}` : 'svg'} ${String(info.size).padStart(7)}B ${meta?.hasAlpha ? 'alpha' : ''}`,
    );
  }
  log(
    `  ${urls.length} registry URLs, ${urls.length - missing.length} present, ${missing.length} missing, ${(totalBytes / 1024).toFixed(1)} KiB`,
  );
  if (missing.length > 0) process.exitCode = 1;
}

// --------------------------------------------------------------------- 主入口 ---

const run = async (name, fn) => {
  if (!steps.includes(name)) return;
  log(`\n=== ${name} ===`);
  await fn();
};

await run('arenas', processArenas);
await run('icons', processIcons);
await run('characters', processCharacters);
await run('vfx', processVfx);
await run('background', processBackground);
await run('portraits', processPortraits);
await run('provenance', writeProvenance);
await run('ui', () => processUiArt(OUT_DIR, DRY_RUN));
await run('check', checkRegistry);

const total = report.reduce((sum, entry) => sum + entry.bytes, 0);
log(
  `\n${DRY_RUN ? 'would write' : 'wrote'} ${report.length} files, ${(total / 1024).toFixed(1)} KiB total`,
);
