/**
 * PNG decoding for the visual checks, built on the maintained `fast-png` decoder (devDependency)
 * instead of a hand-written parser. Playwright screenshots are 8-bit, non-interlaced PNGs, so the
 * decoded data is normalised to an RGBA buffer: a zero-copy view when the file already carries four
 * channels, and a minimal expansion for three-channel RGB (the library's own converter is used for
 * indexed palettes). `pixelStats` and `imageDigest` keep their previous behaviour.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { convertIndexedToRgb, decode } from 'fast-png';

export interface RawImage {
  width: number;
  height: number;
  /** RGBA pixels. */
  data: Buffer;
}

function expandRgbToRgba(rgb: Uint8Array, pixelCount: number): Buffer {
  const rgba = Buffer.alloc(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    rgba[index * 4] = rgb[index * 3];
    rgba[index * 4 + 1] = rgb[index * 3 + 1];
    rgba[index * 4 + 2] = rgb[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

export function decodePng(buffer: Buffer): RawImage {
  const png = decode(buffer);
  if (png.depth !== 8) throw new Error(`unsupported PNG bit depth ${png.depth}; this helper targets 8-bit screenshots`);

  const source = png.palette
    ? convertIndexedToRgb(png)
    : png.data instanceof Uint8Array
      ? png.data
      : new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  const channels = png.palette ? 3 : png.channels;
  const pixelCount = png.width * png.height;

  if (channels === 4) {
    // Zero-copy view over the decoded buffer.
    return { width: png.width, height: png.height, data: Buffer.from(source.buffer, source.byteOffset, source.byteLength) };
  }
  if (channels === 3) {
    return { width: png.width, height: png.height, data: expandRgbToRgba(source, pixelCount) };
  }
  throw new Error(`unsupported PNG channel count ${channels}; this helper targets RGB/RGBA screenshots`);
}

export interface PixelStats {
  width: number;
  height: number;
  /** Standard deviation of luminance across sampled pixels: 0 for a flat frame. */
  stddev: number;
  /** Number of distinct sampled colours. */
  distinct: number;
  /** Mean luminance 0-255. */
  mean: number;
}

export function pixelStats(image: RawImage, step = 2): PixelStats {
  const { width, height, data } = image;
  const values: number[] = [];
  const colors = new Set<number>();
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 4;
      const red = data[at];
      const green = data[at + 1];
      const blue = data[at + 2];
      values.push(0.2126 * red + 0.7152 * green + 0.0722 * blue);
      colors.add((red << 16) | (green << 8) | blue);
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  return { width, height, stddev: Math.sqrt(variance), distinct: colors.size, mean };
}

/** Content hash of the decoded pixels: identical frames share a digest. */
export function imageDigest(image: RawImage): string {
  return createHash('sha1').update(image.data).digest('hex');
}
