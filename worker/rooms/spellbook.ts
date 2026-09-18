import { OPENING_COUNTDOWN_MS, THEME_PRESETS } from '../../shared/protocol';
import { generateSpellSet } from '../generation/spells';
import { SEAT_TTL_MS } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { currentConns, onlineUserIds, reconcileHost } from './sockets';
import { armLobbySeatExpiry, listPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import type { RoomRow } from './storage/schema';

/**
 * Preset themes share their cached book; custom themes generate once per match.
 * Recheck the room token after either operation so a departed or superseded match
 * cannot be resurrected by a delayed response. The book is frozen in the room at admission.
 */
export async function runGeneration(scope: RoomScope, room: RoomRow): Promise<void> {
  const token = room.generation_token;
  if (token === null) return;
  const outcome = THEME_PRESETS.some((preset) => preset.theme === room.theme)
    ? await scope.env.SPELL_BOOKS.getByName(room.theme).getSpellBook(room.theme)
    : await generateSpellSet(scope.env, {
        theme: room.theme,
        variation: `${room.match_id ?? ''}:${room.generation_seq}`,
      });

  const fresh = getRoom(scope.sql);
  if (!fresh || fresh.phase !== 'generating' || fresh.generation_token !== token) return;

  if (!outcome.ok) {
    console.error('[room] generation failed', fresh.id, outcome.reason);
    abortMatch(scope, outcome.message);
    return;
  }

  // One shared book, one opening countdown: the combat deadline is derived
  // from the end of this countdown so it is fixed the moment combat starts.
  const countdownEnd = Date.now() + OPENING_COUNTDOWN_MS;
  updateRoom(scope.sql, {
    spell_book: JSON.stringify(outcome.spells),
    phase: 'countdown',
    started_at: null,
    deadline: countdownEnd,
    error: null,
    generation_token: null,
    generation_claim: null,
  });
  pushSnapshots(scope);
}

/** Returns the room to an open lobby after a match never came together. */
export function abortMatch(scope: RoomScope, message: string): void {
  updateRoom(scope.sql, {
    phase: 'lobby',
    deadline: 0,
    started_at: null,
    ended_at: null,
    end_reason: null,
    match_id: null,
    spell_book: null,
    events_json: '[]',
    event_seq: 0,
    locked: 0,
    error: message,
    generation_token: null,
    generation_claim: null,
    reservation_state: 'none',
    reservation_expires_at: null,
  });
  const roster = listPlayers(scope.sql);
  armLobbySeatExpiry(
    scope.sql,
    [...onlineUserIds(roster, currentConns(scope))],
    Date.now() + SEAT_TTL_MS,
  );
  reconcileHost(scope);
  pushSnapshots(scope);
}
