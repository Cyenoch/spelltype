import type { Texture } from 'pixi.js';
import {
  ASSETS,
  ELEMENT_ORDER,
  characterForSlot,
  combatFxFor,
  elementGlyph,
  spellIconFor,
} from '../assets';
import {
  acquireTextures,
  createSilhouetteTexture,
  releaseTextures,
  trimTexture,
} from '../textures';
import type { Element } from '../../../shared/protocol';

const CHARACTER_COUNT = 4;

/**
 * 竞技场的美术资源及其生命周期。
 *
 * 共享文件在初始化时一次性获取；只有某次施法才会用到的美术
 * （咒文符印、命中变体）通过同一个引用计数加载器按需获取，
 * 因此某个舞台在文件仍在传输途中被销毁时，绝不会卸载下一个舞台即将接收的纹理。
 */
export interface StageAssets {
  /** 已成功加载的战斗角色立绘，已裁切至其可见像素。 */
  characters: Texture[];
  sigil: Texture | null;
  /** 按 `ELEMENT_ORDER` 顺序排列的元素符形美术；加载失败的文件保持 `null`。 */
  glyphs: (Texture | null)[];
  /** 每个已加载战斗角色对应一张剪影，索引与 `characters` 一一对应。 */
  silhouettes: Texture[];
  /** 当每个战斗角色文件都加载成功时为 true；否则竞技场处于降级状态。 */
  ready: boolean;
  /** 获取共享美术资源；绝不交回一个没有战斗角色的竞技场。 */
  load(): Promise<void>;
  /** 按需美术：请求进行中或请求失败后为 `null`。 */
  request(url: string): Texture | null;
  /** 在施法之前，预热该次施法所需的符印与命中变体。 */
  warmSpell(element: Element, index: number): void;
  /** 每次有懒加载资源到达时调用一次，使舞台能重绘等待它的内容。 */
  onArtArrived: (() => void) | null;
  /** 释放并销毁本模块创建的所有内容，无论是否加载成功。 */
  dispose(): void;
}

export function createStageAssets(): StageAssets {
  const characterUrls = Array.from({ length: CHARACTER_COUNT }, (_, index) =>
    characterForSlot(index),
  );
  const glyphUrls = ELEMENT_ORDER.map((element) => elementGlyph(element));
  const sharedUrls = [...characterUrls, ASSETS.sigil, ...glyphUrls];

  /** 本模块自行创建的纹理（裁切后的图块、剪影），必须由本模块销毁。 */
  const ownedTextures: Texture[] = [];
  const silhouettes: Texture[] = [];
  /** 美术与咒文符印按需获取：一场对局只会用到其中少数几张。 */
  const lazyTextures = new Map<string, Texture | null>();
  const lazyPending = new Set<string>();
  const lazyRequested = new Set<string>();

  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const texture of ownedTextures) {
      if (!texture.destroyed) texture.destroy(false);
    }
    for (const texture of silhouettes) texture.destroy(true);
    releaseTextures(sharedUrls);
    releaseTextures([...lazyRequested]);
    lazyRequested.clear();
    lazyTextures.clear();
  };

  /**
   * 按需美术。这里任何环节都不阻塞竞技场：
   * 文件缺失只意味着该图层在本次命中中继续使用其过程化兜底方案。
   */
  const request = (url: string): Texture | null => {
    const cached = lazyTextures.get(url);
    if (cached !== undefined) return cached;
    if (lazyPending.has(url)) return null;
    lazyPending.add(url);
    lazyRequested.add(url);
    void acquireTextures([url]).then(([texture]) => {
      lazyPending.delete(url);
      if (disposed) return;
      lazyTextures.set(url, texture);
      if (!texture) return;
      // 美术已到达：舞台把它放到此前等待它的位置并重绘。
      assets.onArtArrived?.();
    });
    return null;
  };

  /**
   * 在需要之前预热某次施法将要使用的美术：咒文符印与当前元素的全部命中变体。
   * 没有这一步，某道咒文的第一次命中会在其美术下载完成之前就落地，从而只显示过程化兜底效果。
   */
  const warmSpell = (element: Element, index: number): void => {
    request(spellIconFor(element, index));
    for (let variant = 0; variant < 4; variant += 1) {
      request(combatFxFor(element, variant));
    }
  };

  const assets: StageAssets = {
    characters: [],
    sigil: null,
    glyphs: [],
    silhouettes,
    ready: false,
    onArtArrived: null,

    async load(): Promise<void> {
      const records = await acquireTextures(sharedUrls);
      const rawCharacters = records.slice(0, CHARACTER_COUNT);
      assets.sigil = records[CHARACTER_COUNT] ?? null;
      assets.glyphs = records.slice(CHARACTER_COUNT + 1);

      const crops = rawCharacters.map((texture) => {
        if (!texture) return null;
        const trimmed = trimTexture(texture);
        if (trimmed !== texture) ownedTextures.push(trimmed);
        return trimmed;
      });
      assets.characters = crops.filter((texture): texture is Texture => texture !== null);
      if (assets.characters.length === 0) {
        // 没有战斗角色美术就没有可展示的竞技场；调用方会回退到 DOM 界面，
        // 而不是拿到一个占位战场。销毁仍由调用方负责，
        // 使其能在这批美术被释放之前先关闭渲染器。
        throw new Error('战斗角色素材加载失败');
      }
      for (const texture of assets.characters) silhouettes.push(createSilhouetteTexture(texture));
      assets.ready = assets.characters.length === CHARACTER_COUNT;
    },

    request,

    warmSpell,

    dispose,
  };
  return assets;
}
