/**
 * Battle helpers: readers for the live arena DOM plus drivers that play real spells through the
 * real input field. Everything here reads the contract DuelInterface documents (data-testid hooks
 * and data-* attributes), never incidental wording or private implementation.
 *
 * Full-match drivers commit the remaining text through the real field in one input event;
 * typing.spec.ts keeps the per-keystroke, correction, paste and IME coverage. Both paths
 * still require server acknowledgement, atomic damage and advancement.
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  DAMAGE_PER_CHARACTER,
  WS_PROTOCOL,
  type Player,
  type RoomSnapshot,
  type SelfInputGate,
} from '../../shared/protocol';
import { apiJson, selfIdentity, type Identity } from './api';
import { settle } from './app';

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

/** Seat account ids in DOM order (visual columns: the viewer leftmost, then the other slots ascending). */
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

/** Read the accessible target, not the glyphs that now display the player's actual typos. */
export async function spellText(page: Page): Promise<string> {
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

/**
 * The room's authoritative snapshot, read the way every v2 client must: the exact room GET is
 * version-gated, so the read carries the current protocol header. A missing or wrong header is the
 * server's 409, never a snapshot.
 */
export async function roomSnapshot(context: BrowserContext, roomId: string): Promise<RoomSnapshot> {
  const response = await apiJson<RoomSnapshot>(context, `/api/rooms/${roomId}`, {
    headers: { 'X-Spelltype-Protocol': WS_PROTOCOL },
  });
  expect(response.status).toBe(200);
  return response.body;
}

/** The viewer's own input gate from a snapshot (null outside valid playing state). */
export function snapshotGate(snapshot: RoomSnapshot, identity: Identity): SelfInputGate | null {
  snapshotPlayer(snapshot, identity);
  return snapshot.selfInputGate ?? null;
}

/* ------------------------------------------------------------- input gate */

export interface GateIndicator {
  present: boolean;
  mode: string;
  /** Milliseconds the gate still withholds readiness, or null when ready/absent. */
  remainingMs: number | null;
  reason: string;
  text: string;
}

/** Reads the station's input-gate indicator (`data-testid="input-gate"`). */
export async function gateIndicator(page: Page): Promise<GateIndicator> {
  const gate = page.getByTestId('input-gate');
  if ((await gate.count()) === 0)
    return { present: false, mode: '', remainingMs: null, reason: '', text: '' };
  const remaining = await gate.getAttribute('data-ready-remaining-ms');
  return {
    present: true,
    mode: (await gate.getAttribute('data-mode')) ?? '',
    remainingMs: remaining === null || remaining === '' ? null : Number(remaining),
    reason: (await gate.getAttribute('data-reason')) ?? '',
    text: ((await gate.textContent()) ?? '').trim(),
  };
}

/**
 * Waits until this page's viewer may lawfully complete their current spell: the room is playing,
 * the viewer's own gate is published, and the server clock has reached `notBefore`.
 *
 * The identity the first observation captured — match, spell index, draft epoch — defines what is
 * being waited for. A later snapshot whose match differs, whose viewer fell or whose state is
 * broken fails fast with diagnostics instead of timing out on an entry that can never become
 * ready. A mere index/epoch advance inside the same match just re-captures the current identity.
 */
export async function waitForInputGate(page: Page, timeout = 60_000): Promise<void> {
  const roomId = new URL(page.url()).searchParams.get('room');
  if (!roomId) throw new Error('waitForInputGate: the page is not in a room');
  const identity = await selfIdentity(page.context());
  const deadlineAt = Date.now() + timeout;
  let captured: { matchId: string; spellIndex: number; draftEpoch: number } | null = null;
  let last = '';
  for (;;) {
    if (Date.now() > deadlineAt)
      throw new Error(
        `waitForInputGate: not ready within ${timeout}ms (room ${roomId}, ${last || 'no snapshot yet'})`,
      );
    const snapshot = await roomSnapshot(page.context(), roomId);
    const self = snapshotPlayer(snapshot, identity);
    last = `phase=${snapshot.phase} match=${snapshot.matchId} index=${self.spellIndex} epoch=${snapshot.selfInputGate?.draftEpoch} notBefore=${snapshot.selfInputGate?.notBefore}`;
    if (snapshot.phase === 'finished' || snapshot.matchId === null)
      throw new Error(`waitForInputGate: the match settled before the gate opened (${last})`);
    if (snapshot.phase !== 'playing')
      throw new Error(`waitForInputGate: expected playing, saw ${snapshot.phase} (${last})`);
    if (self.eliminatedAt !== null)
      throw new Error(`waitForInputGate: this viewer is eliminated (${last})`);
    const gate = snapshot.selfInputGate;
    if (gate === null)
      throw new Error(
        `waitForInputGate: playing without a published gate is broken state (${last})`,
      );
    if (
      captured === null ||
      snapshot.matchId !== captured.matchId ||
      self.spellIndex !== captured.spellIndex
    ) {
      if (captured !== null && snapshot.matchId !== captured.matchId)
        throw new Error(
          `waitForInputGate: the match changed while waiting (${captured.matchId} → ${snapshot.matchId})`,
        );
      captured = {
        matchId: snapshot.matchId,
        spellIndex: self.spellIndex,
        draftEpoch: gate.draftEpoch,
      };
    }
    if (snapshot.serverNow >= gate.notBefore) return;
    await settle(120);
  }
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
 * authoritative target is inserted, so a restored accepted draft is never duplicated. This
 * exercises the browser's input event, not paste or a direct WebSocket/API shortcut. Resolve
 * only when the server advances the viewer's cursor (or ends the match).
 *
 * The completion is lawful input: first wait until this viewer's own gate says the spell's time
 * floor has passed (never a hardcoded sleep, never a client-side guess at 35ms). A match that
 * settled while waiting is not an error — the loop callers treat a finished match as done.
 */
export async function completeSpell(page: Page): Promise<string> {
  if ((await battlePhase(page)) === 'playing') {
    try {
      await waitForInputGate(page);
    } catch (error) {
      if ((await battlePhase(page)) !== 'finished') throw error;
    }
  }
  const text = await spellText(page);
  const index = await selfSpellIndex(page);
  const current = await inputValue(page);
  if (current !== '' && !text.startsWith(current)) await clearField(page);
  const committed = await inputValue(page);
  const missing = text.startsWith(committed) ? text.slice(committed.length) : text;
  if (missing !== '') {
    const input = typingInput(page);
    await input.focus();
    await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await page.keyboard.insertText(missing);
  }
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
