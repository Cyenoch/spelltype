import { inputNotBefore } from '../scoring';
import type { PlayerRow, RoomRow } from '../db/schema';

/**
 * The input gate's shared verdicts, used by combat judging and snapshot building alike.
 *
 * Deliberately tiny: the storage columns live in the schema, the two pure time rules live in
 * scoring, and this module only answers "is this stored state coherent" — so a damaged seat is
 * refused everywhere for the same reason and with the same message instead of drifting per
 * callsite. No policy framework: one constant, two predicates.
 */

/** The one refusal a playing seat with incoherent stored eligibility gets. */
export const INPUT_GATE_ERROR_MESSAGE = '施法状态异常，暂不能施法，请稍后重试。';

/**
 * True when the room's locked match policy is missing or malformed. A match in this state may
 * neither play nor settle into results: the policy columns are written once at start and are
 * the only source every later decision reads.
 */
export function roomPolicyValid(room: RoomRow): boolean {
  return (
    room.input_policy_version !== null &&
    room.input_policy_version.length > 0 &&
    (room.input_policy_mode === 'observe' || room.input_policy_mode === 'enforce') &&
    room.input_min_ms_per_code_point !== null &&
    Number.isSafeInteger(room.input_min_ms_per_code_point) &&
    room.input_min_ms_per_code_point > 0
  );
}

/**
 * One bounded machine-reason line for an incoherent playing seat or policy. Combat judging,
 * match settling and the countdown transition all refuse damaged state through this one shape,
 * so the log schema cannot drift per callsite; fields only a machine correlates — never a user
 * identity, a connection or any input payload.
 */
export function reportGateStateInvalid(room: RoomRow): void {
  console.error({ event: 'input_gate_state_invalid', roomId: room.id, phase: room.phase });
}

/** The eligibility every judging and snapshot path reads, checked for coherence as one value. */
export type InputGateState = {
  policyVersion: string;
  mode: 'observe' | 'enforce';
  minMsPerCodePoint: number;
  notBefore: number;
};

/**
 * The seat's stored eligibility, or `null` when it is damaged: missing, or not matching what
 * the room's locked policy implies for this spell's length. A `null` seat is never "ready at
 * time zero": its own snapshot carries null gates plus an explicit error so the client stops
 * submitting instead of treating the damage as sane, and its inputs are refused. A non-null
 * answer carries the policy fields the check just verified, so callers never re-derive —
 * and never fabricate — a mode, cost or ready-moment for a damaged row.
 */
export function inputGateState(
  room: RoomRow,
  player: PlayerRow,
  spellLength: number,
): InputGateState | null {
  const cost = room.input_min_ms_per_code_point;
  if (
    !roomPolicyValid(room) ||
    cost === null ||
    !Number.isSafeInteger(spellLength) ||
    spellLength <= 0
  ) {
    return null;
  }
  const openedAt = player.input_opened_at;
  const notBefore = player.input_not_before;
  if (
    openedAt === null ||
    notBefore === null ||
    !Number.isSafeInteger(openedAt) ||
    !Number.isSafeInteger(notBefore) ||
    openedAt < 0 ||
    notBefore < 0
  ) {
    return null;
  }
  // An exhausted epoch cannot express another recovery; judging and UI must agree it is damaged.
  if (
    !Number.isSafeInteger(player.draft_epoch) ||
    player.draft_epoch < 0 ||
    player.draft_epoch === Number.MAX_SAFE_INTEGER
  )
    return null;
  try {
    if (inputNotBefore(spellLength, openedAt, cost) !== notBefore) return null;
  } catch {
    return null;
  }
  // `roomPolicyValid` has just verified these three; the narrow casts restate what the
  // predicate proved instead of inventing a fallback for a field it guarantees.
  return {
    policyVersion: room.input_policy_version as string,
    mode: room.input_policy_mode as InputGateState['mode'],
    minMsPerCodePoint: cost,
    notBefore,
  };
}
