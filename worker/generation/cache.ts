import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { ThemeBookCache } from './book-cache';
import type { SpellBookOutcome } from './book-cache';
import { generateSpellSet } from './spells';

export type { SpellBookOutcome } from './book-cache';

/**
 * One shared spell book per THEME_PRESETS entry. The Durable Object name is the preset's exact
 * trimmed theme string, so every room on a theme — private or quick-match — reads the same
 * cached book and shares its five-minute freshness window. Custom themes never reach this
 * class: the room generates those per match instead.
 */
export class SpellBookCache extends DurableObject<Env> {
  private readonly books: ThemeBookCache;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.books = new ThemeBookCache({
      sql: ctx.storage.sql,
      sync: () => ctx.storage.sync(),
      generate: (input) => generateSpellSet(env, input),
    });
  }

  getSpellBook(theme: string): Promise<SpellBookOutcome> {
    return this.books.getSpellBook(theme);
  }
}
