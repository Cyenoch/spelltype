import type { Element } from '../../shared/protocol';

/**
 * Single registry for static assets. Generated artwork lives under
 * public/assets/ alongside the hand-authored vector fallbacks; see
 * public/assets/provenance.json for exactly how every shipped file was made
 * (generated source vs. locally derived asset).
 */
export const ASSETS = {
  background: '/assets/bg/academy-hall.webp',
  backgroundFallback: '/assets/bg/academy.svg',
  sigil: '/assets/sigil.svg',
  spark: '/assets/effects/spark.svg',
  avatars: [
    '/assets/avatars/seat-1.webp',
    '/assets/avatars/seat-2.webp',
    '/assets/avatars/seat-3.webp',
    '/assets/avatars/seat-4.webp',
  ],
  avatarFallbacks: [
    '/assets/avatars/seat-1.svg',
    '/assets/avatars/seat-2.svg',
    '/assets/avatars/seat-3.svg',
    '/assets/avatars/seat-4.svg',
  ],
  elementGlyphs: {
    arcane: '/assets/elements/arcane.svg',
    fire: '/assets/elements/fire.svg',
    ice: '/assets/elements/ice.svg',
    storm: '/assets/elements/storm.svg',
  } satisfies Record<Element, string>,
  /** Arena backdrops, cycled per match. Index 0..3. */
  arenas: [
    '/assets/arenas/arena-1.webp',
    '/assets/arenas/arena-2.webp',
    '/assets/arenas/arena-3.webp',
    '/assets/arenas/arena-4.webp',
  ],
  /**
   * Full-body combatants with a real alpha channel, indexed by seat slot.
   * slot 0 = arcane, 1 = fire, 2 = ice, 3 = storm.
   */
  characters: [
    '/assets/characters/slot-0-arcane.webp',
    '/assets/characters/slot-1-fire.webp',
    '/assets/characters/slot-2-ice.webp',
    '/assets/characters/slot-3-storm.webp',
  ],
  /** Four spell sigils per element, indexed by spellIndex % 4. */
  spellIcons: {
    arcane: [
      '/assets/spells/arcane-1.webp',
      '/assets/spells/arcane-2.webp',
      '/assets/spells/arcane-3.webp',
      '/assets/spells/arcane-4.webp',
    ],
    fire: [
      '/assets/spells/fire-1.webp',
      '/assets/spells/fire-2.webp',
      '/assets/spells/fire-3.webp',
      '/assets/spells/fire-4.webp',
    ],
    ice: [
      '/assets/spells/ice-1.webp',
      '/assets/spells/ice-2.webp',
      '/assets/spells/ice-3.webp',
      '/assets/spells/ice-4.webp',
    ],
    storm: [
      '/assets/spells/storm-1.webp',
      '/assets/spells/storm-2.webp',
      '/assets/spells/storm-3.webp',
      '/assets/spells/storm-4.webp',
    ],
  } satisfies Record<Element, readonly string[]>,
  /** Four impact effects per element, indexed by spellIndex % 4. Alpha WebPs. */
  combatFx: {
    arcane: [
      '/assets/combat-fx/arcane-1.webp',
      '/assets/combat-fx/arcane-2.webp',
      '/assets/combat-fx/arcane-3.webp',
      '/assets/combat-fx/arcane-4.webp',
    ],
    fire: [
      '/assets/combat-fx/fire-1.webp',
      '/assets/combat-fx/fire-2.webp',
      '/assets/combat-fx/fire-3.webp',
      '/assets/combat-fx/fire-4.webp',
    ],
    ice: [
      '/assets/combat-fx/ice-1.webp',
      '/assets/combat-fx/ice-2.webp',
      '/assets/combat-fx/ice-3.webp',
      '/assets/combat-fx/ice-4.webp',
    ],
    storm: [
      '/assets/combat-fx/storm-1.webp',
      '/assets/combat-fx/storm-2.webp',
      '/assets/combat-fx/storm-3.webp',
      '/assets/combat-fx/storm-4.webp',
    ],
  } satisfies Record<Element, readonly string[]>,
} as const;

export const SEAT_LIMIT = 4;

export const ELEMENT_ORDER = ['arcane', 'fire', 'ice', 'storm'] as const;

function wrap(index: number, length: number): number {
  return ((Math.trunc(index) % length) + length) % length;
}

export function avatarForSlot(slot: number): string {
  return ASSETS.avatars[wrap(slot, SEAT_LIMIT)] ?? ASSETS.avatars[0];
}

export function avatarFallbackForSlot(slot: number): string {
  return ASSETS.avatarFallbacks[wrap(slot, SEAT_LIMIT)] ?? ASSETS.avatarFallbacks[0];
}

export function elementGlyph(element: Element): string {
  return ASSETS.elementGlyphs[element] ?? ASSETS.elementGlyphs.arcane;
}

/** Full-body combatant art for a seat slot, cycled if the room ever exceeds four seats. */
export function characterForSlot(slot: number): string {
  return ASSETS.characters[wrap(slot, ASSETS.characters.length)] ?? ASSETS.characters[0];
}

/** Arena backdrop for a match, cycled by index. */
export function arenaFor(index: number): string {
  return ASSETS.arenas[wrap(index, ASSETS.arenas.length)] ?? ASSETS.arenas[0];
}

/** Spell sigil for an element, cycled by spellIndex. */
export function spellIconFor(element: Element, index: number): string {
  const icons = ASSETS.spellIcons[element] ?? ASSETS.spellIcons.arcane;
  return icons[wrap(index, icons.length)] ?? icons[0];
}

/** Impact effect for an element, cycled by spellIndex. */
export function combatFxFor(element: Element, index: number): string {
  const fx = ASSETS.combatFx[element] ?? ASSETS.combatFx.arcane;
  return fx[wrap(index, fx.length)] ?? fx[0];
}
