import { expect, test } from '../support/test';
import { newContext, openHome } from '../support/ui';

test('场景立即重建时获得可用纹理，另一持有者释放不会销毁共享纹理', async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    await openHome(page);
    const result = await page.evaluate(async () => {
      // Load inside the browser realm: a static test import would run Pixi in Node.
      const textureModule = '/src/pixi/textures.ts';
      const assetModule = '/src/assets.ts';
      const { acquireTextures, releaseTextures } = await import(textureModule);
      const { ASSETS } = await import(assetModule);
      const urls = [ASSETS.characters[0]];
      const [original] = await acquireTextures(urls);
      if (!original) throw new Error('Character texture failed to load');
      const width = original.width;
      releaseTextures(urls);
      const [replacement] = await acquireTextures(urls);
      const [shared] = await acquireTextures(urls);
      releaseTextures(urls);
      try {
        // Allow Pixi's asynchronous unload from the previous scene to finish.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          destroyed: replacement?.destroyed,
          sourceAvailable: Boolean(replacement?.source),
          widthPreserved: replacement?.width === width,
          sharedTextureSurvives: shared === replacement && !shared.destroyed,
        };
      } finally {
        releaseTextures(urls);
      }
    });
    expect(result).toEqual({
      destroyed: false,
      sourceAvailable: true,
      widthPreserved: true,
      sharedTextureSurvives: true,
    });
  } finally {
    await context.close();
  }
});

test('GPU 粒子首帧可见，清空后消失且复用后恢复', async ({ browser }) => {
  const context = await newContext(browser);
  try {
    const page = await context.newPage();
    await openHome(page);
    const result = await page.evaluate(async () => {
      // This probe must instantiate the renderer in the browser, not Node.
      const probeModule = '/tests/support/pixi-probes.ts';
      const { probeParticlePixels } = await import(probeModule);
      return probeParticlePixels();
    });
    // A radius-8 circle must paint its interior, not only an accidental edge pixel.
    expect(result.spawned).toBeGreaterThan(150);
    expect(result.cleared).toBe(0);
    expect(result.reused).toBe(result.spawned);
  } finally {
    await context.close();
  }
});
