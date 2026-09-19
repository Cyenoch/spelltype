import { Assets, CanvasSource, Rectangle, Texture } from 'pixi.js';

/**
 * 带引用计数的 PIXI 资源缓存访问层。
 *
 * 同一时间可能有两个场景存活（页面背景与战斗竞技场），二者可能都需要同一张图片，
 * 因此绝不单独调用加载器：每次 acquire 都由一次 release 配平，
 * 只有当最后一个持有者放手后 GPU 资源才会被卸载。
 * 加载失败的 url 会在该引用的整个生命周期内被记住，
 * 以免缺少某个资源的场景每帧重复请求；失败解析为 `null` 而非抛出，
 * 因为调用方总可以退回到其他图层。
 */
interface Entry {
  texture: Texture | null;
  refs: number;
  loading: Promise<Texture | null> | null;
}

const entries = new Map<string, Entry>();
const unloading = new Map<string, Promise<void>>();

/** 无人再引用时丢弃该条目；在仍被引用时调用无副作用。 */
function dropEntry(url: string, entry: Entry): void {
  if (entry.refs > 0) return;
  entries.delete(url);
  const texture = entry.texture;
  entry.texture = null;
  if (!texture) return;
  const pending = Assets.unload(url)
    .catch(() => {
      // 仅用于销毁流程；卸载失败时已无任何后续影响需要处理。
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
      // Pixi 的加载器在其缓存的加载 Promise 上会一直保留到异步卸载完成为止。
      // 新的持有者绝不能收到正在被销毁的纹理。
      const pending = unloading.get(url);
      const loading = pending
        ? pending.then(() => Assets.load<Texture>(url))
        : Assets.load<Texture>(url);
      entry.loading = loading.then(
        (texture) => {
          entry.loading = null;
          entry.texture = texture;
          // 在加载进行中放手的持有者不能在此处执行卸载
          // （那会把资源从即将接收它的持有者那里移除），
          // 因此现在补完卸载 —— 除非期间有人重新获取了它。
          dropEntry(url, entry);
          return entry.refs > 0 ? texture : null;
        },
        () => {
          entry.loading = null;
          entry.texture = null;
          // 保留至其最后一个持有者释放为止：此处删除会让新的获取者创建出替代条目，
          // 而该持有者之后的释放就会错误地递减这个新条目。
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
    // 仍在进行中的加载由拥有它的加载器负责收尾，在那之前该待定条目保持原位：
    // 现在丢弃它，会让紧随销毁之后挂载的场景错过它本应接收的资源。
    if (entry.loading) continue;
    dropEntry(url, entry);
  }
}

/**
 * 将纹理裁切至其可见像素范围，同时保持同一个 GPU 资源不变。
 *
 * 角色立绘带有透明留白，这些留白会把绘制出的形象推离竞技场围绕脚线所做的布局：
 * 生命条会悬浮、地面阴影会落在空处，一张带 4% 内边距的精灵也不会出现在布局所指定的位置。
 * 当美术资源本身已填满画框，或像素无法读取时，返回原始纹理。
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

/** 白色角色剪影：可着色的命中/KO 叠加层，无需运行时遮罩。 */
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
