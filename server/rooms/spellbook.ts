import { OPENING_COUNTDOWN_MS } from '../../shared/protocol';
import type { GenerationOutcome } from '../generation/spells';
import { SEAT_TTL_MS } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { currentConns, onlineUserIds, reconcileHost } from './sockets';
import { armLobbySeatExpiry, listPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import type { Transaction } from '../db';
import { participantKind } from './opponents';

/**
 * Returns the room to an open lobby after a match never came together. A
 * previous attempt was interrupted before it could settle, or the provider
 * failed: re-calling the provider would silently re-bill, so the match is
 * abandoned honestly instead.
 */
export async function abortMatch(scope: RoomScope, message: string): Promise<void> {
  await scope.transact(async (tx) => abortMatchInTx(tx, scope, message));
  await pushSnapshots(scope);
}

/** The transactional body of `abortMatch`; callers own the transaction. */
export async function abortMatchInTx(
  tx: Transaction,
  scope: RoomScope,
  message: string,
): Promise<void> {
  await updateRoom(tx, scope.roomId, {
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
    opponent_next_at: null,
    reservation_state: 'none',
    reservation_expires_at: null,
  });
  const roster = await listPlayers(tx, scope.roomId);
  const room = await getRoom(tx, scope.roomId);
  if (!room) throw new Error('room:not_found');
  const present = onlineUserIds(roster, await currentConns(tx, scope.roomId, scope.registry));
  for (const row of roster) if (participantKind(room, row) !== 'human') present.add(row.user_id);
  await armLobbySeatExpiry(tx, scope.roomId, [...present], Date.now() + SEAT_TTL_MS);
  await reconcileHost(tx, scope.roomId, scope.registry);
}

/**
 * Applies one finished generation attempt inside a fresh serialized command.
 *
 * The token captured when the attempt started is re-checked here, so a response
 * from a superseded match or attempt can never overwrite newer state — and a
 * stale response never triggers another paid call. One shared book, one opening
 * countdown: the combat deadline is derived from the end of this countdown so
 * it is fixed the moment combat starts.
 */
export async function applyGenerationOutcome(
  scope: RoomScope,
  token: string,
  outcome: GenerationOutcome,
): Promise<void> {
  await scope.transact(async (tx) => {
    const fresh = await getRoom(tx, scope.roomId);
    if (!fresh || fresh.phase !== 'generating' || fresh.generation_token !== token) return;

    if (!outcome.ok) {
      console.error('[room] generation failed', fresh.id, outcome.reason);
      await abortMatchInTx(tx, scope, outcome.message);
      return;
    }
    await updateRoom(tx, scope.roomId, {
      spell_book: JSON.stringify(outcome.spells),
      phase: 'countdown',
      started_at: null,
      deadline: Date.now() + OPENING_COUNTDOWN_MS,
      error: null,
      generation_token: null,
      generation_claim: null,
    });
  });
  await pushSnapshots(scope);
}
