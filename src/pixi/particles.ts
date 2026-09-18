import { Particle, ParticleContainer, Rectangle, type Texture, type BLEND_MODES } from 'pixi.js';

/**
 * Fixed-size particle pool over a single `ParticleContainer`.
 *
 * Everything a burst can ever need is allocated once, up front: the `Particle`
 * instances, the per-particle integration state (plain typed arrays) and a
 * free-index stack. Spawning and updating therefore allocate nothing, and the
 * whole pool is one draw call. The pool is bounded by construction: once every
 * slot is busy a new spawn recycles the slot the cursor points at, so a burst
 * storm degrades into shorter trails instead of growing without limit.
 */
export class SparkPool {
  readonly view: ParticleContainer;
  readonly capacity: number;

  private readonly particles: Particle[];
  private readonly active: Uint8Array;
  private readonly elapsed: Float32Array;
  private readonly life: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly spin: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly free: Int32Array;
  private freeCount: number;
  private cursor = 0;
  private alive = 0;

  constructor(texture: Texture, capacity: number, blendMode: BLEND_MODES = 'normal') {
    this.capacity = Math.max(1, capacity);
    const size = this.capacity;

    this.active = new Uint8Array(size);
    this.elapsed = new Float32Array(size);
    this.life = new Float32Array(size);
    this.vx = new Float32Array(size);
    this.vy = new Float32Array(size);
    this.size0 = new Float32Array(size);
    this.size1 = new Float32Array(size);
    this.spin = new Float32Array(size);
    this.gravity = new Float32Array(size);
    this.drag = new Float32Array(size);
    this.baseAlpha = new Float32Array(size);
    this.free = new Int32Array(size);
    this.freeCount = size;

    this.particles = Array.from({ length: size }, (_, index) => {
      this.free[index] = size - 1 - index;
      return new Particle({
        texture,
        x: -4096,
        y: -4096,
        anchorX: 0.5,
        anchorY: 0.5,
        alpha: 0,
      });
    });

    this.view = new ParticleContainer({
      texture,
      particles: this.particles,
      blendMode,
      boundsArea: new Rectangle(-4096, -4096, 8192, 8192),
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true },
    });
    // `dynamicProperties` re-uploads position, rotation, vertex and colour every
    // frame, but the UVs are static and PixiJS only writes static attributes when
    // the container is dirty. Passing `particles` to the constructor never marks
    // it dirty, so without this the UV buffer stays empty and every particle
    // samples texture uv (0, 0) — i.e. nothing is ever drawn.
    this.view.update();
  }

  get live(): number {
    return this.alive;
  }

  /**
   * Emit one particle. Positional on purpose: this is the hot path, called many
   * times per frame, so no options object is built per particle.
   *
   * @param size0 scale at spawn, `size1` scale at death
   * @param spin radians per millisecond, `gravity` px per ms², `drag` velocity
   *   decay per millisecond (0 = no drag)
   */
  spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    lifeMs: number,
    size0: number,
    size1: number,
    tint: number,
    alpha: number,
    spin = 0,
    gravity = 0,
    drag = 0,
  ): void {
    let index: number;
    if (this.freeCount > 0) {
      this.freeCount -= 1;
      index = this.free[this.freeCount];
    } else {
      index = this.cursor % this.capacity;
      this.cursor += 1;
    }

    if (this.active[index] === 0) this.alive += 1;
    this.active[index] = 1;
    this.elapsed[index] = 0;
    this.life[index] = lifeMs;
    this.vx[index] = vx;
    this.vy[index] = vy;
    this.size0[index] = size0;
    this.size1[index] = size1;
    this.spin[index] = spin;
    this.gravity[index] = gravity;
    this.drag[index] = drag;
    this.baseAlpha[index] = alpha;

    const particle = this.particles[index];
    particle.x = x;
    particle.y = y;
    particle.scaleX = size0;
    particle.scaleY = size0;
    particle.rotation = 0;
    particle.tint = tint;
    particle.alpha = alpha;
  }

  update(deltaMS: number): void {
    if (this.alive === 0) return;
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.active[index] === 0) continue;
      const elapsed = this.elapsed[index] + deltaMS;
      if (elapsed >= this.life[index]) {
        this.retire(index);
        continue;
      }
      this.elapsed[index] = elapsed;

      const damping = 1 - this.drag[index] * deltaMS;
      const velocityX = this.vx[index] * (damping > 0 ? damping : 0);
      const velocityY =
        this.vy[index] * (damping > 0 ? damping : 0) + this.gravity[index] * deltaMS;
      this.vx[index] = velocityX;
      this.vy[index] = velocityY;

      const progress = elapsed / this.life[index];
      const particle = this.particles[index];
      particle.x += velocityX * deltaMS;
      particle.y += velocityY * deltaMS;
      particle.rotation += this.spin[index] * deltaMS;
      const scale = this.size0[index] + (this.size1[index] - this.size0[index]) * progress;
      particle.scaleX = scale;
      particle.scaleY = scale;
      // Ease out so a particle fades late and reads as a hot spark, not a blink.
      particle.alpha = this.baseAlpha[index] * (1 - progress * progress);
    }
  }

  clear(): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.active[index] === 0) continue;
      this.retire(index);
    }
  }

  destroy(): void {
    this.view.destroy();
  }

  private retire(index: number): void {
    this.active[index] = 0;
    this.alive -= 1;
    const particle = this.particles[index];
    particle.alpha = 0;
    particle.x = -4096;
    particle.y = -4096;
    this.free[this.freeCount] = index;
    this.freeCount += 1;
  }
}
