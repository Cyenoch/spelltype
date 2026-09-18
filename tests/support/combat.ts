/**
 * Battle helpers: readers for the live arena DOM plus drivers that play real spells through the
 * real input field. Everything here reads the contract DuelInterface documents (data-testid hooks
 * and data-* attributes), never incidental wording or private implementation.
 *
 * Completion is always driven by typing the authoritative target text, so a spec that finishes a
 * match exercises the same path a player does: accepted prefix → exact completion → server
 * acknowledgement → atomic damage + immediate advance.
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { DAMAGE_PER_CHARACTER, type Player, type RoomSnapshot } from '../../shared/protocol';
import { apiJson, type Identity } from './api';

/** Longest a single server round-trip may take before a spec should treat it as a failure. */
const ACK_TIMEOUT = 30_000;

function battlePanel(page: Page): Locator {
  return page.getByTestId('battle-panel');
}

export async function battlePhase(page: Page): Promise<string> {
  return (await battlePanel(page).getAttribute('data-phase')) ?? '';
}

export async function battleMatchId(page: Page): Promise<string> {
  return (await battlePanel(page).getAttribute('data-match-id')) ?? '';
}

/** The viewer's private, monotonic, zero-based spell cursor. */
export async function selfSpellIndex(page: Page): Promise<number> {
  return Number(await battlePanel(page).getAttribute('data-spell-index'));
}

export async function selfSpellsCast(page: Page): Promise<number> {
  return Number(await battlePanel(page).getAttribute('data-spells-cast'));
}

/** `elimination`, `timeout`, or empty while the match is live. */
export async function endReason(page: Page): Promise<string> {
  return (await battlePanel(page).getAttribute('data-end-reason')) ?? '';
}

export function typingInput(page: Page): Locator {
  return page.getByTestId('typing-input');
}

export async function inputValue(page: Page): Promise<string> {
  return typingInput(page).inputValue();
}

export async function castState(page: Page): Promise<string> {
  return (await page.getByTestId('cast-feedback').getAttribute('data-state')) ?? '';
}

/**
 * The application writes `data-*` flags with `String(boolean)`, so a flag is either "true"/"false"
 * or the "1"/"0" form the hook contract documents. Both mean the same thing to a reader.
 */
function flagValue(value: string | null): boolean {
  return value === '1' || value === 'true';
}

/** One seat card, addressed by account id (the DOM keys seats by `data-user`). */
function arenaSeat(page: Page, userId: string): Locator {
  return page.locator(`[data-testid="arena-seat"][data-user="${userId}"]`);
}

/** The seat of the player the viewer's own completions currently damage. */
export function targetSeat(page: Page): Locator {
  return page.locator(
    '[data-testid="arena-seat"][data-target="true"], [data-testid="arena-seat"][data-target="1"]',
  );
}

/** Seat account ids in DOM order (the room orders seats by slot ascending). */
export async function seatOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId('arena-seat')
    .evaluateAll((seats) => seats.map((seat) => seat.getAttribute('data-user') ?? ''));
}

export interface SeatHealth {
  hp: number;
  maxHp: number;
}

export async function seatHealth(page: Page, userId: string): Promise<SeatHealth> {
  const hp = arenaSeat(page, userId).getByTestId('arena-hp');
  return {
    hp: Number(await hp.getAttribute('aria-valuenow')),
    maxHp: Number(await hp.getAttribute('aria-valuemax')),
  };
}

export async function seatIsOut(page: Page, userId: string): Promise<boolean> {
  return flagValue(await arenaSeat(page, userId).getAttribute('data-eliminated'));
}

/** Accepted prefix of another player's current spell, read from their seat card. */
export async function opponentProgress(page: Page, userId: string): Promise<number> {
  return Number(
    await arenaSeat(page, userId).getByTestId('player-progress').getAttribute('aria-valuenow'),
  );
}

/**
 * The authoritative target text of the viewer's current spell. The station renders a screen-reader
 * copy as well, so the visible character run is preferred and the plain copy is the fallback.
 */
export async function spellText(page: Page): Promise<string> {
  const visible = page.getByTestId('spell-text').locator('span[aria-hidden="true"]').first();
  if ((await visible.count()) > 0) return ((await visible.textContent()) ?? '').trim();
  const plain = (await page.getByTestId('spell-text-plain').textContent()) ?? '';
  return plain.replace(/^[^：]*：/, '').trim();
}

/** Whole-match remaining milliseconds while playing, countdown remaining during the opening. */
export async function timerRemaining(page: Page): Promise<number> {
  return Number(await page.getByTestId('match-timer').getAttribute('data-remaining-ms'));
}

/** The room's single deadline: the countdown end, then the combat end. It never extends. */
export async function deadline(page: Page): Promise<number> {
  return Number(await battlePanel(page).getAttribute('data-deadline'));
}
export interface ResultBanner {
  outcome: string;
  endReason: string;
}

export async function resultBanner(page: Page): Promise<ResultBanner> {
  const banner = page.getByTestId('result-banner');
  return {
    outcome: (await banner.getAttribute('data-outcome')) ?? '',
    endReason: (await banner.getAttribute('data-end-reason')) ?? '',
  };
}

export async function saveStatus(page: Page): Promise<string> {
  return (await page.getByTestId('save-status').getAttribute('data-state')) ?? '';
}

export interface FinalRow {
  /** Account id and whatever label text the row carries. */
  user: string;
  text: string;
  rank: number;
  hp: number;
  maxHp: number;
  damage: number;
  spells: number;
  cpm: number;
  accuracy: string;
  eliminated: boolean;
}

/** Every finished-match row, read from the panel's own cells. */
export async function finalRows(page: Page, timeout = ACK_TIMEOUT): Promise<FinalRow[]> {
  await expect(page.getByTestId('final-panel')).toBeVisible({ timeout });
  const rows = await page.getByTestId('final-row').all();
  return Promise.all(
    rows.map(async (row) => {
      const hpCell = row.getByTestId('final-row-hp');
      const numberIn = async (id: string) =>
        Number(((await row.getByTestId(id).textContent()) ?? '').replace(/[^\d.-]/g, ''));
      return {
        user: (await row.getAttribute('data-user')) ?? '',
        text: ((await row.textContent()) ?? '').trim(),
        rank: Number(await row.getAttribute('data-rank')),
        hp: Number(await hpCell.getAttribute('data-hp')),
        maxHp: Number(await hpCell.getAttribute('data-max-hp')),
        damage: await numberIn('final-row-damage'),
        spells: await numberIn('final-row-spells'),
        cpm: await numberIn('final-row-cpm'),
        accuracy: ((await row.getByTestId('final-row-accuracy').textContent()) ?? '').trim(),
        eliminated: flagValue(await row.getAttribute('data-eliminated')),
      };
    }),
  );
}

/** The room's authoritative view of one participant. */
export function snapshotPlayer(snapshot: RoomSnapshot, identity: Identity): Player {
  const player = snapshot.players.find((entry) => entry.id === identity.userId);
  if (!player) throw new Error(`room ${snapshot.id} has no player ${identity.username}`);
  return player;
}

export async function roomSnapshot(context: BrowserContext, roomId: string): Promise<RoomSnapshot> {
  const response = await apiJson<RoomSnapshot>(context, `/api/rooms/${roomId}`);
  expect(response.status).toBe(200);
  return response.body;
}

/* ------------------------------------------------------------------ waits */

/**
 * A live combat phase on this page: the phase is playing, the arena finished its asynchronous
 * initialisation, the target is published and the field accepts input.
 */
export async function waitForCombat(page: Page, timeout = 60_000): Promise<void> {
  await expect(battlePanel(page)).toHaveAttribute('data-phase', 'playing', { timeout });
  await expect(page.getByTestId('battle-canvas-wrap')).toHaveAttribute(
    'data-stage',
    /ready|degraded/,
    { timeout },
  );
  await expect(battlePanel(page)).toHaveAttribute('data-render', /canvas|dom/, { timeout });
  await expect(typingInput(page)).toBeEditable({ timeout });
  await expect.poll(() => spellText(page), { timeout }).not.toBe('');
}

/** Waits until the match has settled (phase finished, ranks published). */
export async function waitForMatchEnd(page: Page, timeout = 120_000): Promise<void> {
  await expect(battlePanel(page)).toHaveAttribute('data-phase', 'finished', { timeout });
  await expect(page.getByTestId('final-panel')).toBeVisible({ timeout });
}

/* ------------------------------------------------------------------ input */

/** Focuses the field, puts the caret after the committed text and types at full speed. */
export async function typeText(page: Page, text: string): Promise<void> {
  const input = typingInput(page);
  await input.click();
  await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.type(text, { delay: 0 });
}

/** Types at the caret/selection without clicking, so an existing selection survives. */
export async function insertIntoField(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 0 });
}

export async function backspace(page: Page, times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) await page.keyboard.press('Backspace');
}

/** Empties the field through the keyboard, whatever it currently holds. */
async function clearField(page: Page): Promise<void> {
  const input = typingInput(page);
  await input.click();
  await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.setSelectionRange(0, field.value.length);
  });
  await backspace(page, 1);
}

/* ------------------------------------------------------------- completion */

/**
 * Waits until the viewer's own spell cursor has moved past `completedIndex`, or the match settled
 * before it could (the completion that ends a match advances the cursor too, so both are accepted).
 */
async function waitForAdvanceOrEnd(
  page: Page,
  completedIndex: number,
  timeout = ACK_TIMEOUT,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await battlePhase(page)) === 'finished') return 'finished';
        return (await selfSpellIndex(page)) > completedIndex ? 'advanced' : 'waiting';
      },
      { timeout },
    )
    .not.toBe('waiting');
}

/**
 * Completes the open spell from whatever the field already holds: only the missing suffix of the
 * authoritative target is typed, so a restored accepted draft is never duplicated. Resolves once
 * the server has acknowledged the completion and the viewer has advanced (or the match ended).
 * Returns the text that was completed.
 */
export async function completeSpell(page: Page): Promise<string> {
  const text = await spellText(page);
  const index = await selfSpellIndex(page);
  const current = await inputValue(page);
  if (current !== '' && !text.startsWith(current)) await clearField(page);
  const committed = await inputValue(page);
  const missing = text.startsWith(committed) ? text.slice(committed.length) : text;
  if (missing !== '') await typeText(page, missing);

  await expect
    .poll(
      async () => (await castState(page)) === 'done' || (await battlePhase(page)) === 'finished',
      { timeout: ACK_TIMEOUT },
    )
    .toBe(true);
  await waitForAdvanceOrEnd(page, index);
  return text;
}

/**
 * Plays real spells until `userId`'s seat is out. Damage is computed by the room from the spell the
 * attacker actually completes, so the loop is driven by observed health, not by arithmetic.
 */
export async function defeatSeat(page: Page, userId: string, maxSpells = 40): Promise<number> {
  let cast = 0;
  while (cast < maxSpells) {
    if ((await battlePhase(page)) !== 'playing') break;
    if ((await seatHealth(page, userId)).hp <= 0) break;
    await completeSpell(page);
    cast += 1;
  }
  if ((await seatHealth(page, userId)).hp > 0 && (await battlePhase(page)) === 'playing') {
    throw new Error(
      `seat ${userId} still has ${(await seatHealth(page, userId)).hp} HP after ${cast} completed spells`,
    );
  }
  return cast;
}

/** Plays real spells until the match settles (either the last opponent falls or time runs out). */
export async function playUntilFinished(page: Page, maxSpells = 60): Promise<number> {
  let cast = 0;
  while (cast < maxSpells && (await battlePhase(page)) !== 'finished') {
    await completeSpell(page);
    cast += 1;
  }
  if ((await battlePhase(page)) !== 'finished')
    throw new Error(`match still live after ${cast} completed spells`);
  return cast;
}

/** Damage a completed spell of `text` deals to a target with `remainingHp` left (bounded by it). */
export function completionDamage(text: string, remainingHp = Number.POSITIVE_INFINITY): number {
  return Math.min(DAMAGE_PER_CHARACTER * Array.from(text).length, remainingHp);
}
