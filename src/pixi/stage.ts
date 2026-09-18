import { Application, Container, Graphics, Sprite, type Texture, type Ticker } from 'pixi.js';
import {
  ASSETS,
  ELEMENT_ORDER,
  arenaFor,
  characterForSlot,
  combatFxFor,
  elementGlyph,
  spellIconFor,
} from '../assets';
import { setData } from '../dom';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../elements';
import { motion } from '../motion';
import { Arena } from './arena';
import { Fighter, type FighterState } from './fighter';
import { FxLayer, createFxTextures, destroyFxTextures, type FxTextures } from './fx';
import { SparkPool } from './particles';
import { acquireTextures, createSilhouetteTexture, releaseTextures, trimTexture } from './textures';
import type { CombatEvent, Element, Player, RoomSnapshot } from '../../shared/protocol';

/**
 * The live battle arena.
 *
 * `update` is fed the authoritative snapshot and `typing` the confirmed local
 * prefix; neither of them decides anything about damage. Hits are drawn from
 * `CombatEvent`s, deduplicated per match by `(matchId, seq)`, so a reconnect
 * that re-delivers the room's event ring never replays an old attack.
 */
export interface BattleStage {
  update(snapshot: RoomSnapshot, selfId: string): void;
  typing(progress: number, element: Element): void;
  destroy(): void;
}

const ARENA_COUNT = 4;
const CHARACTER_COUNT = 4;
const SLOT_COUNT = 4;
const QUEUE_LIMIT = 6;
const SPAWN_GAP_MS = 110;
const FINAL_SECONDS_MS = 10_000;
const GLYPH_SLOTS = 4;
/** Motes drawn between the caster and its locked target. */
const AIM_MOTES = 4;
const GLYPH_MIN_GAP_MS = 70;
/** Frame clamp: a backgrounded tab must not teleport every effect on return. */
const MAX_FRAME_MS = 48;
/** Backing-store ceiling so a 4K arena does not allocate a 4K×4K buffer. */
const MAX_BACKING_PIXELS = 2_600_000;

interface AttackOrder {
  seq: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  eliminated: boolean;
  spellIndex: number;
}

interface GlyphSlot {
  sprite: Sprite;
  active: boolean;
  elapsed: number;
  drift: number;
}

interface SeatGeometry {
  x: number;
  feetY: number;
  height: number;
  width: number;
  present: boolean;
}

export async function createBattleStage(host: HTMLElement): Promise<BattleStage> {
  const rect = host.getBoundingClientRect();
  const cssWidth = Math.max(320, rect.width || host.clientWidth || 960);
  const cssHeight = Math.max(240, rect.height || host.clientHeight || 540);
  const pixelRatio = window.devicePixelRatio || 1;
  const areaBound = Math.sqrt(MAX_BACKING_PIXELS / (cssWidth * cssHeight));

  const app = new Application();
  await app.init({
    backgroundAlpha: 0,
    resizeTo: host,
    antialias: pixelRatio <= 1.5,
    // High-DPI is capped by both the device ratio and the total pixel budget.
    resolution: Math.min(pixelRatio, 1.75, areaBound),
    autoDensity: true,
    autoStart: false,
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    preference: ['webgl', 'webgpu', 'canvas'],
    webgl: { powerPreference: 'high-performance' },
    webgpu: { powerPreference: 'high-performance' },
  });
  app.stage.eventMode = 'none';
  app.canvas.setAttribute('aria-hidden', 'true');

  const rendererName = app.renderer.name;
  const canvasRenderer = rendererName === 'canvas';
  if (canvasRenderer) {
    // A 2D canvas at device resolution is slower than the GPU path by an order of
    // magnitude; the arena keeps every shape it has, just at 1:1 pixels.
    app.renderer.resolution = 1;
    app.resize();
  }

  const arenaUrls = Array.from({ length: ARENA_COUNT }, (_, index) => arenaFor(index));
  const characterUrls = Array.from({ length: CHARACTER_COUNT }, (_, index) => characterForSlot(index));
  const glyphUrls = ELEMENT_ORDER.map((element) => elementGlyph(element));
  const sharedUrls = [...arenaUrls, ...characterUrls, ASSETS.sigil, ...glyphUrls];

  let destroyed = false;
  let reduced = motion.reduced || host.dataset.motion === 'reduced';
  let records: (Texture | null)[] = [];
  let fxTextures: FxTextures | null = null;
  /** Textures this stage created itself (trimmed crops) and must destroy. */
  const ownedTextures: Texture[] = [];
  const silhouettes: Texture[] = [];

  const teardownFailedInit = (): void => {
    releaseTextures(sharedUrls);
    if (fxTextures) destroyFxTextures(fxTextures);
    for (const texture of ownedTextures) {
      if (!texture.destroyed) texture.destroy(false);
    }
    for (const texture of silhouettes) texture.destroy(true);
    app.destroy({ removeView: true }, { children: true });
  };

  try {
    records = await acquireTextures(sharedUrls);
  } catch (error) {
    teardownFailedInit();
    throw error;
  }

  const arenaTextures = records.slice(0, ARENA_COUNT);
  const rawCharacters = records.slice(ARENA_COUNT, ARENA_COUNT + CHARACTER_COUNT);
  const sigilTexture = records[ARENA_COUNT + CHARACTER_COUNT] ?? null;
  const glyphTextures = records.slice(ARENA_COUNT + CHARACTER_COUNT + 1);

  const characterTextures = rawCharacters.map((texture) => {
    if (!texture) return null;
    const trimmed = trimTexture(texture);
    if (trimmed !== texture) ownedTextures.push(trimmed);
    return trimmed;
  });

  const availableCharacters = characterTextures.filter((texture): texture is Texture => texture !== null);
  if (availableCharacters.length === 0) {
    // Without the combatant art there is no arena to show; the caller falls back
    // to the DOM interface instead of being handed a placeholder battlefield.
    teardownFailedInit();
    throw new Error('战斗角色素材加载失败');
  }

  try {
    for (const texture of availableCharacters) silhouettes.push(createSilhouetteTexture(texture));
    fxTextures = createFxTextures(app);
  } catch (error) {
    teardownFailedInit();
    throw error;
  }

  const shapes = fxTextures;
  const budget = canvasRenderer ? 0.55 : reduced ? 0.5 : 1;
  const pools = {
    arcane: new SparkPool(shapes.shard.arcane, Math.round(96 * budget), 'add'),
    fire: new SparkPool(shapes.shard.fire, Math.round(96 * budget), 'add'),
    ice: new SparkPool(shapes.shard.ice, Math.round(96 * budget), 'add'),
    storm: new SparkPool(shapes.shard.storm, Math.round(96 * budget), 'add'),
  } satisfies Record<Element, SparkPool>;
  const motes = new SparkPool(shapes.glow, reduced ? 28 : Math.round(110 * budget), 'normal');

  const world = new Container();
  app.stage.addChild(world);

  const arena = new Arena(
    { skies: arenaTextures, sigil: sigilTexture, glow: shapes.glow, ring: shapes.ring },
    motes,
    () => reduced,
  );
  const fighterLayer = new Container();
  const aimLayer = new Container();
  const aimLine = new Graphics();
  const emblem = new Sprite(shapes.glow);
  emblem.anchor.set(0.5);
  emblem.blendMode = 'add';
  emblem.alpha = 0.42;
  emblem.visible = false;
  aimLayer.addChild(aimLine, emblem);

  const fx = new FxLayer(shapes, pools, reduced);
  // The targeting tether sits behind the fighters so it never draws across a
  // character: it is read in the gap between them, the way a real sight line is.
  world.addChild(arena.back, arena.floor, fx.ground, aimLayer, fighterLayer, fx.air, arena.fore);

  const fighters = Array.from({ length: SLOT_COUNT }, (_, slot) => {
    const texture = availableCharacters[slot % availableCharacters.length];
    const fighter = new Fighter(
      slot,
      { body: texture, silhouette: silhouettes[slot % availableCharacters.length], glow: shapes.glow, ring: shapes.ring },
      ELEMENT_CORE[ELEMENT_ORDER[slot % ELEMENT_ORDER.length]],
    );
    fighter.setActive(false);
    fighterLayer.addChild(fighter.view);
    return fighter;
  });

  const glyphSlots: GlyphSlot[] = [];
  for (let index = 0; index < GLYPH_SLOTS; index += 1) {
    const sprite = new Sprite(glyphTextures[0] ?? shapes.shard.arcane);
    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    sprite.visible = false;
    fx.air.addChild(sprite);
    glyphSlots.push({ sprite, active: false, elapsed: 0, drift: 0.05 + index * 0.01 });
  }

  const geometry: SeatGeometry[] = Array.from({ length: SLOT_COUNT }, () => ({
    x: 0,
    feetY: 0,
    height: 0,
    width: 0,
    present: false,
  }));
  const slotByUser = new Map<string, number>();
  const occupancy = new Array<Player | null>(SLOT_COUNT).fill(null);
  const queue: AttackOrder[] = [];
  /** Artwork and spell sigils are fetched on demand: a match touches a handful. */
  const lazyTextures = new Map<string, Texture | null>();
  const lazyPending = new Set<string>();
  const lazyRequested = new Set<string>();

  let matchId: string | null = null;
  let phase: RoomSnapshot['phase'] = 'lobby';
  let deadline = 0;
  let serverOffset = 0;
  let lastSeq = 0;
  let primed = false;
  let selfId = '';
  let selfSlot = -1;
  let selfSpellLength = 0;
  let selfProgress = 0;
  let chargeElement: Element = 'arcane';
  let spellIndex = 0;
  let spawnClock = 0;
  let clock = 0;
  let shake = 0;
  let lastImpactAt = -1000;
  let hitCount = 0;
  let typingCount = 0;
  let frameCount = 0;
  let paintCount = 0;
  let glyphClock = 0;
  let victoryApplied = false;
  let openingPlayed = false;
  let lastSeating = '';
  let settleTimer: number | null = null;
  let arenaRotation = 0;
  const deferredKo = new Map<number, number>();

  /**
   * Every render the stage performs outside the ticker (initial layout, resize,
   * reduced-motion repaint) goes through here, so `data-paints` is an honest
   * count of on-demand paints and `data-frames` of ticker-driven ones.
   */
  const paint = (): void => {
    if (destroyed) return;
    paintCount += 1;
    setData(host, 'paints', paintCount);
    app.render();
  };

  const advance = (deltaMS: number): void => {
    fx.update(deltaMS);
    for (const fighter of fighters) fighter.update(deltaMS, 0.5);
    updateGlyphs(deltaMS);
  };

  /**
   * On-demand artwork. Nothing here blocks the arena: a missing file simply
   * means that layer keeps its procedural fallback for this hit. The request goes
   * through the same reference-counted loader as the shared art, so a stage that
   * is torn down while a file is still in flight cannot unload a texture that the
   * next stage is about to receive.
   */
  const requestTexture = (url: string): Texture | null => {
    const cached = lazyTextures.get(url);
    if (cached !== undefined) return cached;
    if (lazyPending.has(url)) return null;
    lazyPending.add(url);
    lazyRequested.add(url);
    void acquireTextures([url]).then(([texture]) => {
      lazyPending.delete(url);
      if (destroyed) return;
      lazyTextures.set(url, texture);
      if (!texture) return;
      // The artwork arrived: put it on the caster's sigil and repaint.
      drawEmblem();
      paint();
    });
    return null;
  };

  /**
   * Warms the art a cast will need before it is needed: the spell sigil and every
   * impact variant of the current element. Without this the first hit of a spell
   * lands before its artwork has finished downloading and shows the procedural
   * fallback instead.
   */
  const warmSpellArt = (element: Element, index: number): void => {
    requestTexture(spellIconFor(element, index));
    for (let variant = 0; variant < 4; variant += 1) {
      requestTexture(combatFxFor(element, variant));
    }
  };

  const layout = (): void => {
    if (destroyed) return;
    const width = app.screen.width;
    const height = app.screen.height;
    const resolution = Math.min(
      window.devicePixelRatio || 1,
      canvasRenderer ? 1 : 1.75,
      Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, width * height)),
    );
    if (app.renderer.resolution !== resolution) app.renderer.resolution = resolution;
    arena.layout(width, height);

    const present: number[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const occupied = occupancy[slot] !== null;
      geometry[slot].present = occupied;
      if (occupied) present.push(slot);
    }
    if (present.length === 0) {
      paint();
      return;
    }

    const inset = width * 0.06;
    const span = Math.max(1, width - inset * 2);
    const columnWidth = span / present.length;
    const feetY = height * 0.92;
    const bodyHeight = height * 0.82;
    const barOffsetY = Math.max(14, Math.min(26, height * 0.04));

    present.forEach((slot, index) => {
      const x = inset + columnWidth * (index + 0.5);
      const seat = geometry[slot];
      const box = fighters[slot].layout({
        x,
        feetY,
        bodyHeight,
        maxWidth: columnWidth * 0.86,
        barOffsetY,
        baselineSpace: Math.max(18, height - feetY),
      });
      // The drawn box, not the nominal one: a width-limited column would
      // otherwise leave every anchor above the character's head.
      seat.x = x;
      seat.feetY = feetY;
      seat.height = box.height;
      seat.width = box.width;
    });

    drawAim(true);
    drawEmblem();
    paint();
  };

  const chest = (slot: number, out: { x: number; y: number }): void => {
    const seat = geometry[slot];
    out.x = seat.x;
    out.y = seat.feetY - seat.height * 0.62;
  };
  const stance = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };

  /** The room targets the next alive player clockwise from the caster's slot. */
  const aimSlot = (): number => {
    if (selfSlot < 0 || !occupancy[selfSlot]) return -1;
    for (let step = 1; step <= SLOT_COUNT; step += 1) {
      const slot = (selfSlot + step) % SLOT_COUNT;
      const player = occupancy[slot];
      if (player && player.eliminatedAt === null) return slot;
    }
    return -1;
  };

  let aimSignature = '';
  const drawAim = (force = false): void => {
    const targetSlot = aimSlot();
    const signature = `${selfSlot}|${targetSlot}|${phase}|${chargeElement}`;
    if (!force && signature === aimSignature) return;
    aimSignature = signature;
    aimLine.clear();
    if (targetSlot < 0 || phase !== 'playing') return;
    chest(selfSlot, stance);
    chest(targetSlot, target);
    const color = ELEMENT_COLORS[chargeElement];
    const dx = target.x - stance.x;
    const dy = target.y - stance.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;

    const targetY = geometry[targetSlot].feetY - 2;
    // A few glowing motes rather than a rule: they fade with distance, so the
    // tether reads as magic drifting towards the locked target.
    for (let index = 0; index < AIM_MOTES; index += 1) {
      const at = (index + 1) / (AIM_MOTES + 1);
      const strength = 1 - at * 0.7;
      const x = stance.x + dx * at + Math.sin(index * 2.4) * 7;
      const y = stance.y + dy * at + Math.cos(index * 1.9) * 4;
      aimLine.circle(x, y, 4.5).fill({ color, alpha: 0.1 * strength });
      aimLine.circle(x, y, 1.9).fill({ color, alpha: 0.34 * strength });
    }

    // The lock marker owns the target's ground ring, so it reads as a deliberate
    // targeting reticle rather than a stray circle near their feet.
    aimLine.ellipse(target.x, targetY, 46, 15).stroke({ width: 2, color, alpha: 0.55 });
    aimLine.ellipse(target.x, targetY, 34, 11).stroke({ width: 1, color, alpha: 0.4 });
    for (let index = 0; index < 4; index += 1) {
      const angle = (Math.PI * 2 * index) / 4 + Math.PI / 4;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      aimLine
        .moveTo(target.x + cos * 40, targetY + sin * 13)
        .lineTo(target.x + cos * 54, targetY + sin * 18)
        .stroke({ width: 3, color, alpha: 0.5, cap: 'round' });
    }
  };

  const drawEmblem = (): void => {
    const icon = requestTexture(spellIconFor(chargeElement, spellIndex));
    if (icon) {
      emblem.texture = icon;
      emblem.tint = 0xffffff;
    } else {
      // The generated spell sigil is fetched on demand; until it lands (or if it
      // never does) the element rune stands in for it.
      emblem.texture = shapes.rune[chargeElement];
      emblem.tint = ELEMENT_COLORS[chargeElement];
    }
    emblem.visible = phase === 'playing';
    if (selfSlot < 0) return;
    const seat = geometry[selfSlot];
    if (!seat.present) return;
    // Behind the caster's own body, so it reads as a casting halo instead of a
    // wireframe drawn over their face.
    emblem.position.set(seat.x, seat.feetY - seat.height * 0.66);
    const size = seat.height * 0.42;
    emblem.width = size;
    emblem.height = size;
  };

  const updateGlyphs = (deltaMS: number): void => {
    for (const slot of glyphSlots) {
      if (!slot.active) continue;
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / 520);
      slot.sprite.y -= deltaMS * slot.drift;
      slot.sprite.alpha = (1 - progress) * 0.9;
      slot.sprite.rotation += deltaMS * 0.002;
      if (progress < 1) continue;
      slot.active = false;
      slot.sprite.visible = false;
    }
  };

  const emitGlyph = (element: Element, x: number, y: number, amount: number): void => {
    const texture = glyphTextures[ELEMENT_ORDER.indexOf(element)] ?? shapes.shard[element];
    for (let index = 0; index < amount; index += 1) {
      const slot = glyphSlots.find((candidate) => !candidate.active) ?? glyphSlots[0];
      slot.active = true;
      slot.elapsed = 0;
      slot.sprite.texture = texture;
      slot.sprite.tint = ELEMENT_CORE[element];
      slot.sprite.visible = true;
      slot.sprite.alpha = 0.9;
      slot.sprite.scale.set(0.5 + index * 0.06);
      slot.sprite.position.set(x + (index - 0.5) * 14, y);
    }
  };

  const applyImpact = (order: AttackOrder, instant: boolean): void => {
    const targetSlot = slotByUser.get(order.targetId);
    const attackerSlot = slotByUser.get(order.attackerId);
    if (targetSlot === undefined) return;

    const seat = geometry[targetSlot];
    const fighter = fighters[targetSlot];
    const base = Math.min(1, Math.max(0.35, order.damage / 64));
    const repeated = clock - lastImpactAt < 150;
    lastImpactAt = clock;
    const strength = repeated ? base * 0.7 : base;

    // The shove goes away from the attacker, so a hit reads as directed.
    const attackerSeat = attackerSlot !== undefined ? geometry[attackerSlot] : undefined;
    fighter.hit(strength, attackerSeat && attackerSeat.x > seat.x ? -1 : 1);
    if (order.eliminated) fighter.commitElimination(reduced || instant);
    if (attackerSlot !== undefined) fighters[attackerSlot].flourish();

    chest(targetSlot, target);
    const art = requestTexture(combatFxFor(order.element, order.spellIndex));
    // The number floats above the target's head; the impact stays on the body.
    const floatY = seat.feetY - seat.height * 1.02;
    // Impact art is normalised to a fraction of the fighter's height, so a 256px
    // or a 1024px texture lands at the same on-screen size.
    const artBaseScale = art ? (seat.height * 0.4) / Math.max(1, art.width) : 1;
    fx.impact(
      target.x,
      target.y,
      floatY,
      order.element,
      order.eliminated ? 1.35 : strength,
      order.damage,
      art,
      artBaseScale,
    );
    if (order.eliminated) {
      fx.elimination(seat.x, seat.feetY - 6, order.element);
      if (!reduced) shake = Math.max(shake, 5);
    }
    hitCount += 1;
    setData(host, 'hits', hitCount);
    setData(host, 'hit-seq', order.seq);
  };

  const resolve = (order: AttackOrder): void => {
    applyImpact(order, false);
    if (reduced) settleReduced();
  };

  const launch = (order: AttackOrder): void => {
    const attackerSlot = slotByUser.get(order.attackerId);
    const targetSlot = slotByUser.get(order.targetId);
    if (attackerSlot === undefined || targetSlot === undefined) return;
    if (reduced) {
      // Reduced motion: no projectile flight, the hit lands where it lands.
      resolve(order);
      return;
    }
    chest(attackerSlot, stance);
    chest(targetSlot, target);
    fx.launch(
      order.seq,
      order.attackerId,
      order.targetId,
      stance.x,
      stance.y,
      target.x,
      target.y,
      order.element,
      order.damage,
      order.eliminated,
      order.spellIndex,
    );
  };

  fx.onLanded = (bolt) => {
    if (destroyed) return;
    resolve({
      seq: bolt.seq,
      attackerId: bolt.attackerId,
      targetId: bolt.targetId,
      element: bolt.element,
      damage: bolt.damage,
      eliminated: bolt.eliminated,
      // The index the bolt was fired with, not the recipient's current cursor.
      spellIndex: bolt.spellIndex,
    });
  };

  const enqueue = (event: CombatEvent): void => {
    const order: AttackOrder = {
      seq: event.seq,
      attackerId: event.attackerId,
      targetId: event.targetId,
      element: event.element,
      damage: event.damage,
      eliminated: event.eliminated,
      spellIndex: event.spellIndex,
    };
    if (reduced) {
      resolve(order);
      return;
    }
    if (queue.length >= QUEUE_LIMIT) {
      applyImpact(order, false);
      return;
    }
    queue.push(order);
  };

  const settleReduced = (): void => {
    advance(160);
    paint();
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      if (destroyed) return;
      advance(2400);
      fx.clear();
      paint();
    }, 900);
  };

  const resetMatch = (nextMatchId: string | null): void => {
    matchId = nextMatchId;
    lastSeq = 0;
    primed = false;
    lastSeating = '';
    victoryApplied = false;
    openingPlayed = false;
    hitCount = 0;
    queue.length = 0;
    deferredKo.clear();
    fx.clear();
    for (const pool of Object.values(pools)) pool.clear();
    motes.clear();
    for (const fighter of fighters) {
      fighter.setActive(false);
      fighter.setVictory(false);
    }
    aimLine.clear();
    emblem.visible = false;
    setData(host, 'hits', 0);
    setData(host, 'hit-seq', null);
    if (nextMatchId) {
      let hash = 0;
      for (let index = 0; index < nextMatchId.length; index += 1) {
        hash = (hash * 31 + nextMatchId.charCodeAt(index)) % 4096;
      }
      arenaRotation = hash;
    }
    arena.setArena(arenaRotation);
  };

  const updateChoreography = (deltaMS: number): void => {
    if (shake > 0) {
      shake = Math.max(0, shake - deltaMS * 0.022);
      world.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake * 0.6);
    } else if (world.position.x !== 0 || world.position.y !== 0) {
      world.position.set(0, 0);
    }

    if (phase === 'countdown' && !openingPlayed && occupancy.some((player) => player !== null)) {
      openingPlayed = true;
      const centreX = app.screen.width / 2;
      const centreY = app.screen.height * 0.9;
      fx.groundWave(centreX, centreY, 0x9f92ff, 1.3);
      fx.typingSpark(centreX, centreY - 40, chargeElement, 6);
      for (const slot of [0, 1, 2, 3]) {
        if (occupancy[slot]) fighters[slot].flourish();
      }
    }

    if (phase !== 'finished') return;
    if (!victoryApplied) {
      victoryApplied = true;
      const winner = occupancy.findIndex((player) => player !== null && player.rank === 1);
      for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
        const player = occupancy[slot];
        if (!player) continue;
        const victorious = slot === winner;
        fighters[slot].setVictory(victorious);
        if (!victorious) continue;
        const seat = geometry[slot];
        fx.victoryPillar(
          seat.x,
          Math.max(34, seat.feetY - seat.height - 18),
          seat.feetY - 18,
          0xffd79a,
        );
      }
    }
  };

  const tick = (tickerInstance: Ticker): void => {
    if (destroyed) return;
    const delta = Math.min(MAX_FRAME_MS, tickerInstance.deltaMS);
    clock += delta;

    arena.update(delta);
    for (const fighter of fighters) fighter.update(delta, clock / 900);
    fx.update(delta);
    updateGlyphs(delta);

    spawnClock -= delta;
    while (queue.length > 0 && spawnClock <= 0) {
      const order = queue.shift();
      if (!order) break;
      launch(order);
      spawnClock = SPAWN_GAP_MS;
    }

    for (const [slot, since] of deferredKo) {
      if (clock - since > 1500) {
        deferredKo.delete(slot);
        fighters[slot].commitElimination(false);
      }
    }

    if (phase === 'playing') {
      aimLine.alpha = 0.45 + Math.sin(clock / 700) * 0.18 + selfProgress * 0.1;
    }
    if (emblem.visible) emblem.rotation += delta * 0.0005;
    updateChoreography(delta);
    // The TickerPlugin renders this same frame right after this callback, so a
    // ticker-driven frame is reported here and nowhere else.
    frameCount += 1;
    setData(host, 'frames', frameCount);
  };

  app.ticker.add(tick);
  app.renderer.on('resize', layout);
  host.appendChild(app.canvas);
  setData(host, 'motion', reduced ? 'reduced' : 'full');
  setData(host, 'renderer', rendererName);
  setData(host, 'stage', availableCharacters.length === ARENA_COUNT ? 'ready' : 'degraded');
  setData(host, 'frames', 0);
  setData(host, 'paints', 0);
  arena.setArena(arenaRotation);
  layout();
  if (!reduced) app.start();

  const unsubscribeMotion = motion.subscribe((isReduced) => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = null;
    if (isReduced) {
      app.stop();
      // Finish confirmed hits before changing modes; dropping in-flight bolts
      // would lose their impact and deferred elimination feedback.
      fx.update(2400);
    }
    reduced = isReduced;
    fx.setReducedMotion(isReduced);
    setData(host, 'motion', isReduced ? 'reduced' : 'full');
    if (isReduced) {
      for (const order of queue) applyImpact(order, true);
      queue.length = 0;
      spawnClock = 0;
      advance(2400);
      fx.clear();
      for (const pool of Object.values(pools)) pool.clear();
      motes.clear();
      shake = 0;
      world.position.set(0, 0);
      arena.update(0);
      paint();
    } else {
      app.start();
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    app.queueResize();
  });
  resizeObserver.observe(host);

  const handlePointer = (event: PointerEvent): void => {
    if (reduced) return;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    arena.setFocus(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      ((event.clientY - rect.top) / rect.height) * 2 - 1,
    );
  };
  window.addEventListener('pointermove', handlePointer, { passive: true });

  const applySnapshot = (snapshot: RoomSnapshot, nextSelfId: string): void => {
    if (snapshot.matchId !== matchId) resetMatch(snapshot.matchId);

    phase = snapshot.phase;
    deadline = snapshot.deadline;
    serverOffset = snapshot.serverNow - Date.now();
    selfId = nextSelfId;
    setData(host, 'phase', phase);

    slotByUser.clear();
    occupancy.fill(null);
    const seated = [...snapshot.players].sort((left, right) => left.slot - right.slot);
    for (const player of seated) {
      if (player.slot < 0 || player.slot >= SLOT_COUNT) continue;
      occupancy[player.slot] = player;
      slotByUser.set(player.id, player.slot);
    }
    setData(host, 'seats', seated.length);

    const self = slotByUser.get(selfId);
    selfSlot = self ?? -1;
    selfSpellLength = self !== undefined ? (occupancy[self]?.spellLength ?? 0) : 0;
    if (self === undefined) selfProgress = 0;
    chargeElement = snapshot.spell?.element ?? chargeElement;
    spellIndex = self !== undefined ? (occupancy[self]?.spellIndex ?? 0) : 0;
    warmSpellArt(chargeElement, spellIndex);

    const instant = !primed || reduced;
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const player = occupancy[slot];
      const fighter = fighters[slot];
      if (!player) {
        fighter.setActive(false);
        continue;
      }
      fighter.setActive(true);
      const state: FighterState = {
        slot,
        connected: player.connected,
        self: player.id === selfId,
        hpRatio: player.maxHp > 0 ? player.hp / player.maxHp : 0,
        eliminated: player.eliminatedAt !== null,
        rank: player.rank,
      };
      const pendingKill = snapshot.events.some(
        (event) => event.seq > lastSeq && event.eliminated && event.targetId === player.id,
      );
      const deferElimination =
        !instant &&
        player.eliminatedAt !== null &&
        !fighter.isDown &&
        // Either the killing bolt is already in flight, or the event that will
        // launch it is in this very snapshot and has not been ingested yet.
        (pendingKill || isIncoming(player.id));
      fighter.applyState(state, instant, deferElimination);
      if (fighter.eliminationPending) deferredKo.set(slot, clock);
      else deferredKo.delete(slot);
      if (player.id === selfId) {
        fighter.setCharge(selfSpellLength > 0 ? selfProgress / selfSpellLength : 0);
      }
    }

    const seating = seated.map((player) => player.slot).join(',');
    if (seating !== lastSeating) {
      lastSeating = seating;
      layout();
    }
    ingestEvents(snapshot);

    const selfPlayer = self !== undefined ? occupancy[self] : null;
    arena.setDanger(selfPlayer ? 1 - selfPlayer.hp / Math.max(1, selfPlayer.maxHp) : 0);
    const remaining = deadline - (Date.now() + serverOffset);
    arena.setFinalSeconds(phase === 'playing' && remaining > 0 && remaining <= FINAL_SECONDS_MS);
    drawEmblem();
    drawAim();
    if (reduced) {
      arena.update(0);
      paint();
    }
  };

  const isIncoming = (userId: string): boolean => {
    if (fx.incomingFor(userId)) return true;
    for (const order of queue) {
      if (order.targetId === userId) return true;
    }
    return false;
  };

  const ingestEvents = (snapshot: RoomSnapshot): void => {
    const events = snapshot.events ?? [];
    if (!primed) {
      // The first snapshot of a match never replays its ring, even on a reconnect
      // that mounts this stage in the middle of a fight.
      primed = true;
      let highest = lastSeq;
      for (const event of events) {
        if (event.seq > highest) highest = event.seq;
      }
      lastSeq = highest;
      return;
    }
    for (const event of events) {
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      enqueue(event);
    }
  };

  return {
    update(snapshot: RoomSnapshot, nextSelfId: string): void {
      if (destroyed) return;
      applySnapshot(snapshot, nextSelfId);
    },

    typing(progress: number, element: Element): void {
      if (destroyed) return;
      const next = Math.max(0, Math.trunc(progress));
      const gained = next - selfProgress;
      chargeElement = element;
      selfProgress = next;
      if (gained > 0 && selfSlot >= 0) {
        const seat = geometry[selfSlot];
        if (clock - glyphClock >= GLYPH_MIN_GAP_MS) {
          glyphClock = clock;
          emitGlyph(element, seat.x + 18, seat.feetY - seat.height * 0.62, Math.min(3, gained));
          fx.typingSpark(seat.x + 18, seat.feetY - seat.height * 0.6, element, Math.min(3, gained));
        }
        // Feedback anchored to the readout strip as well: motes fall from under
        // the text into the caster, so a confirmed keystroke is legible at both
        // ends of the arena without anything being drawn over the text.
        fx.textMotes(seat.x, element, Math.min(4, gained));
        // Observable proof that a typing effect was drawn, for the visual specs.
        typingCount += 1;
        setData(host, 'typing-seq', typingCount);
        setData(host, 'typing-fx', element);
      }
      if (selfSlot >= 0) {
        fighters[selfSlot].setCharge(selfSpellLength > 0 ? selfProgress / selfSpellLength : 0);
        if (reduced) fighters[selfSlot].update(0, 0.5);
      }
      updateGlyphs(reduced ? 120 : 0);
      if (reduced) paint();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      app.stop();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
      unsubscribeMotion();
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointer);
      app.renderer.off('resize', layout);
      app.ticker.remove(tick);
      fx.onLanded = null;
      fx.destroy();
      for (const pool of Object.values(pools)) pool.destroy();
      motes.destroy();
      arena.destroy();
      destroyFxTextures(shapes);
      for (const texture of ownedTextures) {
        if (!texture.destroyed) texture.destroy(false);
      }
      for (const texture of silhouettes) texture.destroy(true);
      releaseTextures(sharedUrls);
      releaseTextures([...lazyRequested]);
      lazyRequested.clear();
      lazyTextures.clear();
      for (const key of [
        'motion',
        'renderer',
        'stage',
        'phase',
        'seats',
        'hits',
        'hit-seq',
        'typing-seq',
        'typing-fx',
        'frames',
        'paints',
      ]) {
        setData(host, key, null);
      }
      // No `releaseGlobalResources` here: Pixi's global pools are shared with the
      // page backdrop, which stays alive across rooms, and draining them under a
      // live renderer is exactly what corrupts it. They are released when the
      // last application on the page goes away.
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
