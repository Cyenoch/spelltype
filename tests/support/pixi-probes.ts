import { Application, Graphics, Rectangle } from 'pixi.js';
import { SparkPool } from '../../src/pixi/particles';

/** Browser-only probe: prove the pooled particles paint, disappear, and paint again. */
export async function probeParticlePixels(): Promise<{ spawned: number; cleared: number; reused: number }> {
  const app = new Application();
  await app.init({ width: 64, height: 64, backgroundAlpha: 0, preference: 'webgl', autoStart: false });
  const shape = new Graphics().circle(16, 16, 8).fill(0xffffff);
  const texture = app.renderer.generateTexture({ target: shape, frame: new Rectangle(0, 0, 32, 32) });
  shape.destroy();
  const pool = new SparkPool(texture, 4);
  app.stage.addChild(pool.view);
  const paintedPixels = (): number => {
    app.render();
    const { pixels } = app.renderer.extract.pixels({ target: app.stage, frame: new Rectangle(0, 0, 64, 64) });
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 8) painted += 1;
    }
    return painted;
  };
  const spawn = (): void => {
    pool.spawn(32, 32, 0, 0, 1000, 1, 1, 0xffffff, 1);
    pool.update(16);
  };
  try {
    spawn();
    const spawned = paintedPixels();
    pool.clear();
    const cleared = paintedPixels();
    spawn();
    return { spawned, cleared, reused: paintedPixels() };
  } finally {
    pool.destroy();
    texture.destroy(true);
    app.destroy({ removeView: true }, { children: true });
  }
}
