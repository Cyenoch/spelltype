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
 * 针对所有符合预期的拒绝情况抛出的错误。`message` 为机器可读的错误码，
 * 以便 HTTP 层可以直接映射而无需解析字符串；`userMessage` 为允许向玩家展示的提示信息。
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
