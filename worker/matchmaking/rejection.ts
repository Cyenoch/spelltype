const messages = {
  'match:cancelled': '匹配已取消，请重新发起匹配',
} as const;

/** Own fields survive Durable Object RPC error serialization. */
export class MatchRejection extends Error {
  readonly status = 409;
  readonly userMessage: string;

  constructor(readonly code: keyof typeof messages) {
    super(code);
    this.name = 'MatchRejection';
    this.userMessage = messages[code];
  }
}
