import { Container, Sprite } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE, ELEMENT_DEEP } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { FighterBox, FighterTextures } from './fighter';

const FLINCH_MS = 280;
const KO_MS = 900;
const KO_TINT = 0x585672;
/**
 * 身体被淘汰时倾覆的弧度。刻意保持浅角度：竖版立绘若旋转放平，
 * 会变成一块宽度等于身高的板子，横跨到相邻赛道上，
 * 因此倒下读起来像一次瘫软 —— 轻微倾斜、略微收缩、蒙上一层灰 —— 而不是完整旋转 90°。
 */
const KO_TILT = 0.55;

/**
 * 所有参与姿态变化的部件：元素光环、地面光池、立绘、其边缘辉光与遮罩，
 * 归入同一组，作为一个整体畏缩、倾覆与上下浮动。
 * 遮罩是身体的平面剪影 —— 倒下时的灰色裹布、命中瞬间的白色冲洗 ——
 * 在两者都不需要时不会进入渲染构建。
 */
export class FighterBody {
  readonly view = new Container();

  private readonly plate: Sprite;
  private readonly shadow: Sprite;
  private readonly ground: Sprite;
  private readonly aura: Sprite;
  private readonly rim: Sprite;
  private readonly art: Sprite;
  private readonly veil: Sprite;

  /** 该席位向哪一侧倾倒：倒下时朝背离隔壁赛道的方向倾斜。 */
  private readonly koDirection: number;
  private rimBaseHeight = 1;
  private rimBaseWidth = 1;
  private koClock = 0;
  private hitFlash = 0;
  private flinch = 0;
  private flinchDirection = 1;
  private connected = true;
  private danger = 0;
  private victory = false;

  constructor(
    textures: FighterTextures,
    private readonly element: Element,
    slot: number,
  ) {
    this.koDirection = slot % 2 === 0 ? 1 : -1;
    const color = ELEMENT_COLORS[element];

    this.aura = new Sprite(textures.glow);
    this.aura.anchor.set(0.5);
    this.aura.blendMode = 'add';
    this.aura.tint = color;
    this.aura.alpha = 0.16;

    this.plate = new Sprite(textures.ring);
    this.plate.anchor.set(0.5);
    this.plate.blendMode = 'add';
    this.plate.tint = color;
    this.plate.alpha = 0.3;

    this.shadow = new Sprite(textures.glow);
    this.shadow.anchor.set(0.5);
    this.shadow.tint = 0x05030d;
    this.shadow.alpha = 0.62;

    // 脚下的角色本元素光池：正是它让角色不再像一张贴在竞技场地板上的剪贴画。
    this.ground = new Sprite(textures.glow);
    this.ground.anchor.set(0.5);
    this.ground.blendMode = 'add';
    this.ground.tint = ELEMENT_DEEP[element];
    this.ground.alpha = 0.5;

    this.art = new Sprite(textures.body);
    this.art.anchor.set(0.5, 1);

    this.rim = new Sprite(textures.body);
    this.rim.anchor.set(0.5);
    this.rim.blendMode = 'add';
    this.rim.tint = ELEMENT_CORE[element];
    this.rim.alpha = 0.2;

    // 位于立绘之上，仅在斗士倒下时出现：身体的平面剪影，灰色，
    // 命中瞬间则为白色。剪影是预先算好的白色美术，因此这种平面填充无需遮罩即可贴合角色 ——
    // 遮罩本质是滤镜，而为每个斗士每帧执行一次滤镜通道，代价太高，
    // 只为了一个大多数时候都不可见的蒙层。
    this.veil = new Sprite(textures.silhouette);
    this.veil.anchor.set(0.5, 1);
    this.veil.tint = 0xa6a3b8;
    this.veil.alpha = 0;
    // 只有在需要绘制蒙层时它才进入渲染构建。
    this.veil.renderable = false;

    this.view.addChild(
      this.plate,
      this.shadow,
      this.ground,
      this.aura,
      this.rim,
      this.art,
      this.veil,
    );
  }

  /** 让整个站立身体适配席位包围盒，并回报其实际绘制尺寸。 */
  layout(bodyHeight: number, maxWidth: number, baselineSpace: number): FighterBox {
    const texture = this.art.texture;
    const aspect = texture.width > 0 ? texture.width / texture.height : 0.5;
    // 窄列中可能按宽度而非高度来适配立绘；调用方需要的是实际绘制出的包围盒，
    // 否则它推导出的每个锚点（胸口、头部、命中点、伤害飘字）都会偏离角色。
    const drawnHeight = Math.min(bodyHeight, maxWidth / Math.max(0.001, aspect));
    const drawnWidth = drawnHeight * aspect;

    this.art.height = drawnHeight;
    this.art.width = drawnWidth;
    // 边缘辉光围绕身体自身中心缩放：若锚定在脚部，
    // 其光晕会悬在头顶之上，读起来像第二个重影人物。
    this.rim.height = drawnHeight * 1.06;
    this.rim.width = drawnWidth * 1.08;
    this.rim.y = -drawnHeight * 0.5;
    this.rimBaseHeight = drawnHeight;
    this.rimBaseWidth = drawnWidth;
    this.veil.height = drawnHeight;
    this.veil.width = drawnWidth;

    const auraSize = Math.max(drawnWidth, drawnHeight * 0.6) * 1.9;
    this.aura.width = auraSize;
    this.aura.height = auraSize;
    this.aura.y = -drawnHeight * 0.52;

    // 地面上的一切都被压扁，以适配脚下的条带，并与相邻的列保持距离。
    const flatHeight = Math.max(16, Math.min(drawnWidth * 0.28, baselineSpace * 1.4));
    const groundWidth = Math.min(drawnWidth * 1.2, maxWidth * 1.15);

    this.ground.width = groundWidth;
    this.ground.height = flatHeight;
    this.ground.y = -flatHeight * 0.25;

    this.shadow.width = Math.min(drawnWidth * 1.05, maxWidth);
    this.shadow.height = flatHeight * 0.5;
    this.shadow.x = flatHeight * 0.22;
    this.shadow.y = -flatHeight * 0.1;

    this.plate.width = groundWidth;
    this.plate.height = flatHeight * 0.5;
    this.plate.y = -flatHeight * 0.2;

    return { height: drawnHeight, width: drawnWidth };
  }

  /** 让身体重新站起，为下一场对局做好准备。 */
  stand(): void {
    this.koClock = 0;
    this.view.rotation = 0;
    this.view.y = 0;
    // 倒下同时会缩小整组；若不加这一步，
    // 回归的斗士（下一场对局、重新加入）会永久停留在 KO 时的缩放比例上。
    this.view.scale.set(1);
    this.art.tint = 0xffffff;
    this.art.alpha = 1;
    this.rim.blendMode = 'add';
    this.rim.tint = ELEMENT_CORE[this.element];
    this.rim.alpha = 0.2;
    this.rim.height = this.rimBaseHeight * 1.06;
    this.rim.width = this.rimBaseWidth * 1.08;
    this.veil.alpha = 0;
    this.veil.renderable = false;
    this.plate.alpha = 0.3;
    this.aura.alpha = 0.16;
    this.shadow.alpha = 0.62;
  }

  /** 开始倒下；`instant` 会直接跳到最终姿态。 */
  collapse(instant: boolean): void {
    this.victory = false;
    this.veil.tint = 0xa6a3b8;
    this.veil.renderable = true;
    this.koClock = instant ? KO_MS : 0;
    this.applyKoPose();
  }

  /**
   * 对命中的可见反应：朝远离打击来源的方向被推开一次，
   * 并在身体上叠加一层白色冲洗（乘算着色只能压暗美术，
   * 因此让命中读出「变亮」靠的是遮罩精灵）。
   */
  hit(strength: number, direction: number): void {
    const scaled = 0.7 + Math.min(1, Math.max(0, strength)) * 0.5;
    this.flinch = FLINCH_MS * scaled;
    this.flinchDirection = direction >= 0 ? 1 : -1;
    this.hitFlash = 1;
    this.veil.tint = 0xffffff;
    this.veil.renderable = true;
  }

  flourish(): void {
    this.hitFlash = Math.max(this.hitFlash, 0.4);
  }

  setVictory(active: boolean): void {
    this.victory = active;
    if (!active) this.aura.tint = ELEMENT_COLORS[this.element];
  }

  /** 站立姿态所需的房间派生输入：连接状态、低血量危险度、刚刚受击。 */
  applyRoomState(connected: boolean, danger: number, hit: boolean): void {
    this.connected = connected;
    this.danger = danger;
    if (hit) this.hitFlash = 1;
  }

  /**
   * 一帧的姿态演算，按顺序执行：畏缩、命中冲洗，
   * 然后根据身体是否倒下，执行倒下动画或站立时的呼吸起伏。
   */
  update(deltaMS: number, pulse: number, down: boolean): void {
    let offsetX = 0;
    let wobble = 0;
    if (this.flinch > 0) {
      this.flinch = Math.max(0, this.flinch - deltaMS);
      const t = this.flinch / FLINCH_MS;
      const shove = t * Math.sin(t * Math.PI);
      offsetX += this.flinchDirection * 18 * shove;
      wobble = this.flinchDirection * 0.05 * shove;
    }
    if (this.view.x !== offsetX) this.view.x = offsetX;
    if (!down) this.view.rotation = wobble;

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - deltaMS / 190);
      // 斗士站立时，遮罩同时充当命中冲洗；一旦斗士倒下，
      // 倒下动画就接管了它的颜色与透明度，否则只要致命一击同时也是命中，
      // 裹布就会一直保持白色。
      if (!down) {
        this.veil.renderable = true;
        this.veil.tint = 0xffffff;
        this.veil.alpha = 0.42 * this.hitFlash;
      }
    } else if (!down && this.veil.alpha !== 0) {
      // 冲洗已结束：再次将遮罩移出渲染构建。
      this.veil.alpha = 0;
      this.veil.renderable = false;
    }

    if (down) {
      if (this.koClock < KO_MS) {
        this.koClock = Math.min(KO_MS, this.koClock + deltaMS);
        this.applyKoPose();
      }
    } else {
      // 低血量让光环变得不安：缓慢而刻意的摆动，绝不是频闪。
      const agitation = 1 + this.danger * 1.6;
      const breath = 0.5 + 0.5 * Math.sin(pulse * agitation);
      this.aura.alpha = (0.12 + breath * 0.12) * (this.connected ? 1 : 0.4);
      this.plate.alpha = 0.24 + breath * 0.16;
      if (this.victory) {
        this.aura.alpha = 0.3 + breath * 0.2;
        this.aura.tint = 0xffd79a;
        this.view.y = -6 - breath * 4;
      } else if (this.view.y !== 0) {
        this.view.y = 0;
      }
    }
  }

  private applyKoPose(): void {
    const progress = Math.min(1, this.koClock / KO_MS);
    const eased = 1 - (1 - progress) * (1 - progress);
    const crumple = 1 - 0.12 * eased;
    this.view.rotation = this.koDirection * KO_TILT * eased;
    this.view.scale.set(crumple);
    // 以脚部为轴旋转会把身体宽度甩到脚线之下，从而横扫过生命条；
    // 这次抬升把它放回地面上。
    const lift = (this.rimBaseWidth * 0.5 * Math.sin(KO_TILT) * crumple + 10) * eased;
    this.view.y = -lift;
    this.art.tint = KO_TINT;
    this.art.alpha = 1;
    this.veil.alpha = 0.72 * eased;
    this.rim.alpha = 0;
    this.plate.alpha = 0.3 * (1 - eased);
    this.aura.alpha = 0;
    this.shadow.alpha = 0.62 - eased * 0.25;
  }
}
