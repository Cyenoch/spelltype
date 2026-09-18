export type RoomRejectionCode =
  | 'room:not_found'
  | 'room:full'
  | 'room:in_progress'
  | 'room:reservation_gone'
  | 'room:unauthenticated';

const REJECTION_STATUS: Record<RoomRejectionCode, number> = {
  'room:not_found': 404,
  'room:full': 409,
  'room:in_progress': 409,
  'room:reservation_gone': 409,
  'room:unauthenticated': 403,
};

/**
 * Thrown for every expected refusal. `message` is the machine-readable code so
 * the HTTP layer can map it without string surgery; `userMessage` is what the
 * player is allowed to see.
 */
export class RoomRejection extends Error {
  readonly code: RoomRejectionCode;
  readonly status: number;
  readonly userMessage: string;

  constructor(code: RoomRejectionCode, userMessage: string) {
    super(code);
    this.name = 'RoomRejection';
    this.code = code;
    this.status = REJECTION_STATUS[code];
    this.userMessage = userMessage;
  }
}
