import { Particle, ParticleContainer, Rectangle, type Texture, type BLEND_MODES } from 'pixi.js';

/**
 * 基于单个 `ParticleContainer` 的固定容量粒子池。
 *
 * 一次爆发（burst）可能需要的全部内容都在初始化时一次性分配：
 * `Particle` 实例、每个粒子的积分状态（普通类型化数组）以及一个空闲索引栈。
 * 因此生成与更新过程零分配，整个池仅一次绘制调用。
 * 池的容量由构造方式本身限定：一旦所有槽位都在使用，新的生成会复用具游标所指的槽位，
 * 于是爆发风暴会退化为更短的拖尾，而不是无限制增长。
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
    // `dynamicProperties` 每帧重新上传位置、旋转、顶点与颜色，
    // 但 UV 是静态的，PixiJS 只在容器被标记为 dirty 时才写入静态属性。
    // 向构造函数传入 `particles` 从不会将其标记为 dirty，因此若缺少下面这一步，
    // UV 缓冲区会一直为空，所有粒子都会采样纹理 uv (0, 0) —— 也就是什么都画不出来。
    this.view.update();
  }

  get live(): number {
    return this.alive;
  }

  /**
   * 发射一个粒子。参数刻意采用位置传参：这里是热路径，每帧会被调用多次，
   * 因此不为每个粒子构造选项对象。
   *
   * @param size0 生成时的缩放，`size1` 消亡时的缩放
   * @param spin 弧度/毫秒，`gravity` 像素/毫秒²，`drag` 每毫秒的速度衰减
   *   （0 表示无阻力）
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
      // 缓出，使粒子较晚才淡出，读起来像炽热火花而非一闪而灭。
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
