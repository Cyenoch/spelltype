import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

const BAR_HEIGHT = 11;
const BAR_WIDTH_MAX = 240;
const BAR_WIDTH_MIN = 84;
/** 仅用于视觉表现：满血时的命中读数略大；数值生命值仍以权威数据为准。 */
const HEALTH_CURVE = 1.1;
const DROP_HOLD_MS = 180;
const DROP_DURATION_MS = 620;
const FLASH_DURATION_MS = 340;
const SHARD_HOLD_MS = 80;
const SHARD_DURATION_MS = 620;
const SHARD_COUNT = 24;

interface HealthShard {
  sprite: Sprite;
  elapsed: number;
  origin: number;
  width: number;
  lift: number;
  drift: number;
  spin: number;
}

/**
 * 真实填充值会立刻对齐到权威生命值。受伤后的余痕短暂保持，
 * 随后随着池化的碎片从失去的区段向上崩飞而燃尽消散。
 * 连续命中会重新指定余痕的目标并复用有界的碎片槽位；
 * 重复的快照绝不会重放同一次命中。身体做姿态变化时，边框始终保持水平。
 */
export class FighterBar {
  readonly view = new Container();

  private readonly seat = new Graphics();
  private readonly frame = new Graphics();
  private readonly back: Sprite;
  private readonly damageFlash: Sprite;
  private readonly damageTrail: Sprite;
  private readonly cutFlare: Graphics;
  private readonly shards: HealthShard[] = [];
  private shardCursor = 0;
  private readonly fill: Sprite;
  private readonly gloss: Sprite;

  private healthRatio = 1;
  private targetRatio = 1;
  private fillRatio = 1;
  private dropFrom = 1;
  private dropElapsed = DROP_HOLD_MS + DROP_DURATION_MS;
  private flashFrom = 1;
  private flashTo = 1;
  private flashElapsed = FLASH_DURATION_MS;
  private barScale = 1;
  private barWidth = BAR_WIDTH_MAX;

  constructor(
    private readonly element: Element,
    private readonly flashTint: number,
  ) {
    this.back = new Sprite(Texture.WHITE);
    this.back.anchor.set(0, 0.5);
    this.back.tint = 0x191430;
    this.back.alpha = 0.9;

    this.damageFlash = new Sprite(Texture.WHITE);
    this.damageFlash.anchor.set(0.5, 0.5);
    this.damageFlash.visible = false;

    this.damageTrail = new Sprite(Texture.WHITE);
    this.damageTrail.anchor.set(0, 0.5);
    this.damageTrail.tint = 0xff784f;
    this.damageTrail.visible = false;
    this.cutFlare = new Graphics()
      .poly([0, -14, 2, -2, 8, 0, 2, 2, 0, 7, -2, 2, -8, 0, -2, -2])
      .fill(0xffedc9);
    this.cutFlare.blendMode = 'add';
    this.cutFlare.visible = false;

    this.fill = new Sprite(Texture.WHITE);
    this.fill.anchor.set(0, 0.5);
    this.fill.tint = ELEMENT_COLORS[element];

    this.gloss = new Sprite(Texture.WHITE);
    this.gloss.anchor.set(0, 0.5);
    this.gloss.tint = ELEMENT_CORE[element];
    this.gloss.alpha = 0.5;

    this.view.addChild(
      this.seat,
      this.back,
      this.damageTrail,
      this.fill,
      this.gloss,
      this.frame,
      this.damageFlash,
      this.cutFlare,
    );
    for (let index = 0; index < SHARD_COUNT; index += 1) {
      const sprite = new Sprite(Texture.WHITE);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.shards.push({
        sprite,
        elapsed: SHARD_HOLD_MS + SHARD_DURATION_MS,
        origin: 0,
        width: 0,
        lift: 0,
        drift: 0,
        spin: 0,
      });
      this.view.addChild(sprite);
    }
  }

  layout(maxWidth: number, barOffsetY: number): void {
    const barWidth = Math.max(BAR_WIDTH_MIN, Math.min(BAR_WIDTH_MAX, maxWidth * 0.92));
    const barX = -barWidth / 2;
    const baseScale = barWidth / Math.max(1, this.back.texture.width);
    const baseHeight = BAR_HEIGHT / Math.max(1, this.back.texture.height);
    this.barScale = baseScale;
    this.barWidth = barWidth;
    this.back.position.set(barX, barOffsetY);
    this.damageFlash.position.set(barX, barOffsetY);
    this.fill.position.set(barX, barOffsetY);
    this.gloss.position.set(barX, barOffsetY - BAR_HEIGHT * 0.28);
    this.back.scale.set(baseScale, baseHeight);
    this.gloss.scale.set(baseScale, baseHeight * 0.34);

    // 绘制在填充精灵之下：一层深色底座，使进度条在竞技场绘制的任何部位上都清晰可读，
    // 同时不遮盖填充本身。
    this.seat
      .clear()
      .roundRect(barX - 6, barOffsetY - BAR_HEIGHT / 2 - 6, barWidth + 12, BAR_HEIGHT + 12, 5)
      .fill({ color: 0x0a0716, alpha: 0.72 })
      .roundRect(barX - 4, barOffsetY - BAR_HEIGHT / 2 - 4, barWidth + 8, BAR_HEIGHT + 8, 4)
      .fill({ color: 0x1b1533, alpha: 0.92 });

    this.frame
      .clear()
      .roundRect(barX - 4, barOffsetY - BAR_HEIGHT / 2 - 4, barWidth + 8, BAR_HEIGHT + 8, 4)
      .stroke({ width: 1.5, color: 0x8a7ec8, alpha: 0.95 })
      .roundRect(barX - 6, barOffsetY - BAR_HEIGHT / 2 - 6, barWidth + 12, BAR_HEIGHT + 12, 5)
      .stroke({ width: 1, color: 0x2a2247, alpha: 1 });
    // 先画四等分刻度，再在两端各加一颗宝石，使边框与竞技场的工艺风格一致。
    for (let tick = 1; tick < 4; tick += 1) {
      const tickX = barX + (barWidth * tick) / 4;
      this.frame
        .moveTo(tickX, barOffsetY - BAR_HEIGHT / 2)
        .lineTo(tickX, barOffsetY + BAR_HEIGHT / 2)
        .stroke({ width: 1, color: 0x0d0a18, alpha: 0.55 });
    }
    this.frame
      .poly([
        barX - 9,
        barOffsetY,
        barX - 3,
        barOffsetY - 6,
        barX + 3,
        barOffsetY,
        barX - 3,
        barOffsetY + 6,
      ])
      .fill({ color: this.flashTint, alpha: 0.9 })
      .poly([
        barX + barWidth + 9,
        barOffsetY,
        barX + barWidth + 3,
        barOffsetY - 6,
        barX + barWidth - 3,
        barOffsetY,
        barX + barWidth + 3,
        barOffsetY + 6,
      ])
      .fill({ color: this.flashTint, alpha: 0.9 });
  }

  /**
   * 只有一次新的权威生命值减少才会触发闪光。重复快照不得将其抹除或重新开始保持计时。
   * 初始状态、治疗/再战以及减弱动效下均立即对齐，绝不凭空制造伤害。
   */
  applyHealth(ratio: number, instant: boolean): boolean {
    const previous = this.healthRatio;
    if (!instant && ratio === previous) return false;
    const target = ratio ** HEALTH_CURVE;
    this.healthRatio = ratio;
    if (instant || ratio >= previous) {
      this.targetRatio = target;
      this.fillRatio = target;
      this.dropFrom = target;
      this.dropElapsed = DROP_HOLD_MS + DROP_DURATION_MS;
      this.flashElapsed = FLASH_DURATION_MS;
      for (const shard of this.shards) shard.sprite.visible = false;
      return false;
    }

    // 第二次命中会重新指定既有下坠的目标，而不再叠加一次完整的保持时间。
    this.dropElapsed =
      this.fillRatio > this.targetRatio ? Math.min(this.dropElapsed, DROP_HOLD_MS) : 0;
    this.dropFrom = this.fillRatio;
    this.flashFrom = this.targetRatio;
    this.flashTo = target;
    this.flashElapsed = 0;
    this.targetRatio = target;
    const loss = this.flashFrom - target;
    const count = Math.min(12, Math.max(5, Math.ceil(loss * 40)));
    for (let index = 0; index < count; index += 1) {
      const shard = this.shards[this.shardCursor];
      this.shardCursor = (this.shardCursor + 1) % SHARD_COUNT;
      shard.elapsed = 0;
      shard.origin = target + (loss * (index + 0.5)) / count;
      shard.width = loss / count;
      shard.lift = 14 + (index % 4) * 7 + Math.min(14, loss * 45);
      shard.drift = ((index % 3) - 1) * (5 + Math.min(10, loss * 35));
      shard.spin = (index % 2 === 0 ? 1 : -1) * (0.8 + index * 0.16);
      shard.sprite.visible = true;
      shard.sprite.tint = index % 3 === 0 ? 0xffedc9 : ELEMENT_COLORS[this.element];
    }
    return true;
  }

  catchUp(deltaMS: number): void {
    this.flashElapsed = Math.min(FLASH_DURATION_MS, this.flashElapsed + deltaMS);
    for (const shard of this.shards) {
      if (!shard.sprite.visible) continue;
      shard.elapsed += deltaMS;
      if (shard.elapsed >= SHARD_HOLD_MS + SHARD_DURATION_MS) shard.sprite.visible = false;
    }
    if (this.fillRatio <= this.targetRatio) return;
    this.dropElapsed = Math.min(DROP_HOLD_MS + DROP_DURATION_MS, this.dropElapsed + deltaMS);
    const progress = Math.max(0, this.dropElapsed - DROP_HOLD_MS) / DROP_DURATION_MS;
    this.fillRatio = this.targetRatio + (this.dropFrom - this.targetRatio) * (1 - progress) ** 3;
  }

  paint(): void {
    const base = this.barScale;
    const heightScale = this.back.scale.y;
    this.fill.scale.set(base * this.targetRatio, heightScale);
    this.fill.visible = this.targetRatio > 0;
    this.fill.tint = this.healthRatio <= 0.25 ? 0xff6d6d : ELEMENT_COLORS[this.element];
    this.gloss.scale.x = base * this.targetRatio;
    this.gloss.visible = this.fill.visible;

    const lost = Math.max(0, this.fillRatio - this.targetRatio);
    this.damageTrail.visible = lost > 0;
    this.damageTrail.position.set(this.back.x + this.barWidth * this.targetRatio, this.back.y);
    this.damageTrail.scale.set(base * lost, heightScale);
    this.damageTrail.alpha =
      0.35 + 0.5 * Math.max(0, 1 - this.dropElapsed / (DROP_HOLD_MS + DROP_DURATION_MS));
    this.damageTrail.tint = this.flashElapsed < 80 ? 0xffedc9 : 0xff784f;
    for (const shard of this.shards) {
      if (!shard.sprite.visible) continue;
      const progress = Math.max(0, shard.elapsed - SHARD_HOLD_MS) / SHARD_DURATION_MS;
      const eased = 1 - (1 - progress) ** 3;
      shard.sprite.position.set(
        this.back.x + this.barWidth * shard.origin + shard.drift * eased,
        this.back.y - shard.lift * eased,
      );
      shard.sprite.width = Math.max(1.5, this.barWidth * shard.width * 0.85) * (1 - progress * 0.7);
      shard.sprite.height = BAR_HEIGHT * (0.8 - progress * 0.6);
      shard.sprite.rotation = shard.spin * eased;
      shard.sprite.alpha = (1 - progress) ** 1.5;
    }

    const flash = 1 - this.flashElapsed / FLASH_DURATION_MS;
    this.damageFlash.visible = flash > 0 && this.flashFrom > this.flashTo;
    this.cutFlare.visible = this.damageFlash.visible;
    this.view.x = flash > 0 ? Math.sin(this.flashElapsed * 0.075) * 2.5 * flash ** 2 : 0;
    if (!this.damageFlash.visible) return;
    this.damageFlash.x = this.back.x + this.barWidth * (this.flashFrom + this.flashTo) * 0.5;
    this.damageFlash.scale.set(
      base * (this.flashFrom - this.flashTo) * (0.7 + flash * 0.3),
      heightScale * 2.8 * flash ** 2,
    );
    this.damageFlash.alpha = flash;
    this.damageFlash.tint = this.flashElapsed < 70 ? 0xffffff : 0xffedaa;
    this.cutFlare.position.set(this.back.x + this.barWidth * this.flashTo, this.back.y);
    this.cutFlare.scale.set(0.6 + flash * 0.7, 0.5 + flash);
    this.cutFlare.alpha = flash ** 2;
  }
}
