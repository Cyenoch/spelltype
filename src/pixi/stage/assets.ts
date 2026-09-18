import type { Texture } from 'pixi.js';
import {
  ASSETS,
  ELEMENT_ORDER,
  arenaFor,
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

const ARENA_COUNT = 4;
const CHARACTER_COUNT = 4;

/**
 * The arena's art and its lifetime.
 *
 * The shared files are acquired once, up front; the art only a specific cast
 * needs (spell sigils, impact variants) is fetched on demand through the same
 * reference-counted loader, so a stage torn down while a file is still in flight
 * cannot unload a texture that the next stage is about to receive.
 */
export interface StageAssets {
  /** Arena backdrops in slot order; a file that failed to load stays `null`. */
  skies: (Texture | null)[];
  /** Combatant art that loaded, trimmed to its visible pixels. */
  characters: Texture[];
  sigil: Texture | null;
  /** Element glyph art in `ELEMENT_ORDER` order; a failed file stays `null`. */
  glyphs: (Texture | null)[];
  /** One silhouette per loaded combatant, index for index with `characters`. */
  silhouettes: Texture[];
  /** True when every combatant file loaded; otherwise the arena is degraded. */
  ready: boolean;
  /** Acquires the shared art; refuses to hand back an arena without combatants. */
  load(): Promise<void>;
  /** On-demand art: `null` while the request is in flight or after it failed. */
  request(url: string): Texture | null;
  /** Warms the sigil and impact variants a cast needs, before it is cast. */
  warmSpell(element: Element, index: number): void;
  /** Called once per lazy arrival, so the stage can redraw what waited for it. */
  onArtArrived: (() => void) | null;
  /** Releases and destroys everything this module created, whether or not it loaded. */
  dispose(): void;
}

export function createStageAssets(): StageAssets {
  const arenaUrls = Array.from({ length: ARENA_COUNT }, (_, index) => arenaFor(index));
  const characterUrls = Array.from({ length: CHARACTER_COUNT }, (_, index) =>
    characterForSlot(index),
  );
  const glyphUrls = ELEMENT_ORDER.map((element) => elementGlyph(element));
  const sharedUrls = [...arenaUrls, ...characterUrls, ASSETS.sigil, ...glyphUrls];

  /** Textures this module created itself (trimmed crops, silhouettes) and must destroy. */
  const ownedTextures: Texture[] = [];
  const silhouettes: Texture[] = [];
  /** Artwork and spell sigils are fetched on demand: a match touches a handful. */
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
   * On-demand artwork. Nothing here blocks the arena: a missing file simply means
   * that layer keeps its procedural fallback for this hit.
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
      // The artwork arrived: the stage puts it where it was waiting and repaints.
      assets.onArtArrived?.();
    });
    return null;
  };

  /**
   * Warms the art a cast will need before it is needed: the spell sigil and every
   * impact variant of the current element. Without this the first hit of a spell
   * lands before its artwork has finished downloading and shows the procedural
   * fallback instead.
   */
  const warmSpell = (element: Element, index: number): void => {
    request(spellIconFor(element, index));
    for (let variant = 0; variant < 4; variant += 1) {
      request(combatFxFor(element, variant));
    }
  };

  const assets: StageAssets = {
    skies: [],
    characters: [],
    sigil: null,
    glyphs: [],
    silhouettes,
    ready: false,
    onArtArrived: null,

    async load(): Promise<void> {
      const records = await acquireTextures(sharedUrls);
      assets.skies = records.slice(0, ARENA_COUNT);
      const rawCharacters = records.slice(ARENA_COUNT, ARENA_COUNT + CHARACTER_COUNT);
      assets.sigil = records[ARENA_COUNT + CHARACTER_COUNT] ?? null;
      assets.glyphs = records.slice(ARENA_COUNT + CHARACTER_COUNT + 1);

      const crops = rawCharacters.map((texture) => {
        if (!texture) return null;
        const trimmed = trimTexture(texture);
        if (trimmed !== texture) ownedTextures.push(trimmed);
        return trimmed;
      });
      assets.characters = crops.filter((texture): texture is Texture => texture !== null);
      if (assets.characters.length === 0) {
        // Without the combatant art there is no arena to show; the caller falls
        // back to the DOM interface instead of being handed a placeholder
        // battlefield. Teardown stays with the caller, so it can put the renderer
        // down before this art is released.
        throw new Error('战斗角色素材加载失败');
      }
      for (const texture of assets.characters) silhouettes.push(createSilhouetteTexture(texture));
      assets.ready = assets.characters.length === ARENA_COUNT;
    },

    request,

    warmSpell,

    dispose,
  };
  return assets;
}
