import { createHash, randomBytes } from 'node:crypto';
import { and, eq, notExists } from 'drizzle-orm';
import type { AuthenticatedSession } from '../contracts';
import type { QueryDatabase } from '../db';
import { accounts, roomSessions, sessions } from '../db/schema';
import { SESSION_TTL_MS, type AccountBan, type User } from '../../shared/protocol';

export const SESSION_COOKIE = 'spelltype_session';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionTicket {
  token: string;
  expiresAt: number;
}

/**
 * 账户在给定时刻的生效封禁。定时封禁以服务器时间为准自动到期：
 * 无需任何清理任务，过期的那一刻起读取为 `null`。
 */
export function activeBan(
  bannedAt: number | null,
  banExpiresAt: number | null,
  now: number,
): AccountBan | null {
  if (bannedAt === null) return null;
  if (banExpiresAt !== null && banExpiresAt <= now) return null;
  return { expiresAt: banExpiresAt };
}

export async function createSession(
  db: QueryDatabase,
  userId: string,
  now = Date.now(),
): Promise<SessionTicket> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .insert(sessions)
    .values({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
  return { token, expiresAt };
}

/** 会话令牌为 32 字节 base64url 格式的随机串；只有这种格式才能作为会话标识。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * 无需访问数据库即可推算出 Cookie 值对应的会话哈希摘要。若传入值缺失或格式非法，
 * 显然不属于有效会话，因此绝不会触发数据库查询或导致 500 错误。
 *
 * 即使当前已无活跃会话，登出操作仍需要计算该哈希：注销 Bearer 令牌并不要求存在活跃会话，
 * 因为重试或并发登出所需要处理的，恰恰正是处于软注销状态的记录及其房间引用。
 */
export function sessionHashFromToken(token: string | undefined): string | null {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  return hashToken(token);
}

/** 数据库仅存储令牌的哈希摘要，因此即使数据库泄露也无法重放伪造会话。 */
export async function loadSession(
  db: QueryDatabase,
  tokenHash: string | null,
  now = Date.now(),
): Promise<AuthenticatedSession | null> {
  if (!tokenHash) return null;
  const [row] = await db
    .select({
      id: sessions.user_id,
      expiresAt: sessions.expires_at,
      username: accounts.username,
      role: accounts.role,
      bannedAt: accounts.banned_at,
      banExpiresAt: accounts.ban_expires_at,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.user_id))
    .where(eq(sessions.token_hash, tokenHash));
  if (!row) return null;
  if (row.expiresAt <= now) {
    // 若房间仍持有其 Socket 连接，墓碑化或过期的会话仍会保留记录：若在此处直接删除，
    // 会级联清除席位引用，从而破坏运行时尚未确认的注销重试目标。只有对房间不再负有责任的会话才会被清理。
    await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.token_hash, tokenHash),
          notExists(db.select().from(roomSessions).where(eq(roomSessions.session_hash, tokenHash))),
        ),
      );
    return null;
  }
  const user: User = { id: row.id, username: row.username };
  return {
    user,
    role: row.role,
    tokenHash,
    expiresAt: row.expiresAt,
    ban: activeBan(row.bannedAt, row.banExpiresAt, now),
  };
}

/**
 * 会话墓碑状态在关闭 Socket 连接前提交。握手注册阶段会对该行加共享锁：
 * 要么注册先完成，要么观察到墓碑状态并予以拒绝。运行时调用在此语句提交后发生，绝不会在持有其会话排他锁时执行。
 */
export async function tombstoneSession(db: QueryDatabase, tokenHash: string): Promise<void> {
  await db.update(sessions).set({ expires_at: 0 }).where(eq(sessions.token_hash, tokenHash));
}

/**
 * 一旦运行时确认 Socket 已关闭，即删除该会话；外键约束将随之级联清除席位记录。
 * 具备幂等性：记录不存在即表示注销已完成。
 */
export async function deleteSession(db: QueryDatabase, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token_hash, tokenHash));
}
