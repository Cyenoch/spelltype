import { randomUUID } from 'node:crypto';

/** Room identity: 24 lowercase hex characters (`roomIdSchema`), generated with a secure RNG. */
export function newRoomId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/** Shard names: one matchmaking coordinator per account, and the one (hard) queue. */
export const USER_SHARD_PREFIX = 'u:';
export const QUEUE_SHARD_PREFIX = 'q:';

export function userShardName(userId: string): string {
  return `${USER_SHARD_PREFIX}${userId}`;
}

/** Every new entry queues hard, so one shard serves all matchmaking. */
export const QUEUE_SHARD_NAME = `${QUEUE_SHARD_PREFIX}hard`;
