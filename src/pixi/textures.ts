import { Assets, CanvasSource, Rectangle, Texture } from 'pixi.js';

/**
 * Reference-counted access to the PIXI asset cache.
 *
 * Two scenes can be alive at once (the page backdrop and the battle arena) and
 * both may want the same image, so the loader is never called on its own: every
 * acquire is balanced by a release, and the GPU resource is only unloaded once
 * the last holder lets go. A failed url is remembered for the lifetime of the
 * reference so a scene that is missing an asset does not re-request it on every
 * frame; failures resolve to `null` instead of throwing, because a caller can
 * always fall back to another layer.
 */
interface Entry {
  texture: Texture | null;
  refs: number;
  loading: Promise<Texture | null> | null;
}

const entries = new Map<string, Entry>();
const unloading = new Map<string, Promise<void>>();

/** Drops an entry once nothing references it; harmless when something still does. */
function dropEntry(url: string, entry: Entry): void {
  if (entry.refs > 0) return;
  entries.delete(url);
  const texture = entry.texture;
  entry.texture = null;
  if (!texture) return;
  const pending = Assets.unload(url)
    .catch(() => {
      // Teardown only; a failed unload has nothing left to affect.
    })
    .finally(() => {
      unloading.delete(url);
    });
  unloading.set(url, pending);
}

export async function acquireTextures(urls: readonly string[]): Promise<(Texture | null)[]> {
  return Promise.all(
    urls.map(async (url) => {
      const existing = entries.get(url);
      if (existing) {
        existing.refs += 1;
        return existing.loading ?? existing.texture;
      }

      const entry: Entry = { texture: null, refs: 1, loading: null };
      entries.set(url, entry);
      // Pixi's loader retains its cached load promise until asynchronous unload
      // finishes. A new holder must not receive the texture being destroyed.
      const pending = unloading.get(url);
      const loading = pending
        ? pending.then(() => Assets.load<Texture>(url))
        : Assets.load<Texture>(url);
      entry.loading = loading.then(
        (texture) => {
          entry.loading = null;
          entry.texture = texture;
          // A holder that let go while the load was in flight cannot unload here
          // (that would remove the resource from whoever is about to receive it),
          // so the unload is completed now — unless someone re-acquired it.
          dropEntry(url, entry);
          return entry.refs > 0 ? texture : null;
        },
        () => {
          entry.loading = null;
          entry.texture = null;
          // Kept until its last holder releases: deleting it here would let a new
          // acquirer create a replacement entry that this holder's later release
          // would then decrement by mistake.
          dropEntry(url, entry);
          return null;
        },
      );
      return entry.loading;
    }),
  );
}

export function releaseTextures(urls: readonly string[]): void {
  for (const url of urls) {
    const entry = entries.get(url);
    if (!entry) continue;
    entry.refs -= 1;
    if (entry.refs > 0) continue;
    // A load still in flight is finished by the loader that owns it, and the
    // pending entry is left in place until then: dropping it now would let a
    // scene that is mounting right after teardown miss the resource it receives.
    if (entry.loading) continue;
    dropEntry(url, entry);
  }
}

/**
 * Crops a texture to its visible pixels, keeping the same GPU resource.
 *
 * Character sheets ship with transparent margins, and those margins would push
 * the drawn figure away from the feet line the arena lays out around: the health
 * bar would float, the ground shadow would sit under nothing, and a sprite that
 * is 4% padding would not be where the layout says it is. Returns the original
 * texture when the art already fills its frame or the pixels cannot be read.
 */
export function trimTexture(texture: Texture): Texture {
  let canvas: HTMLCanvasElement;
  let context: CanvasRenderingContext2D | null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = texture.source.pixelWidth;
    canvas.height = texture.source.pixelHeight;
    context = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return texture;
  }
  if (!context) return texture;

  try {
    context.drawImage(texture.source.resource as CanvasImageSource, 0, 0);
  } catch {
    return texture;
  }

  const { width, height } = canvas;
  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1))
    return texture;

  const trimmed = new Texture({
    source: texture.source,
    frame: new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1),
  });
  return trimmed;
}

/** White character silhouette: tintable hit/KO overlay without a runtime mask. */
export function createSilhouetteTexture(texture: Texture): Texture {
  const { frame, source } = texture;
  const resolution = source.resolution;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(frame.width * resolution));
  canvas.height = Math.max(1, Math.round(frame.height * resolution));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法生成角色轮廓纹理');
  context.drawImage(
    source.resource as CanvasImageSource,
    frame.x * resolution,
    frame.y * resolution,
    frame.width * resolution,
    frame.height * resolution,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
}
