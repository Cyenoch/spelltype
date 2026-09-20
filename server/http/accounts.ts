import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActivitySummary, Profile, SessionInfo } from '../../shared/protocol';
import { roomIdSchema } from '../../shared/validation';
import {
  SESSION_COOKIE,
  loadSession,
  sessionHashFromToken,
  type SessionTicket,
} from '../auth/sessions';
import {
  WECHAT_STATE_COOKIE,
  WECHAT_STATE_PATTERN,
  WECHAT_STATE_TTL_SECONDS,
  beginWechatLogin,
  consumeWechatAttempt,
  finishWechatLogin,
} from '../auth/wechat';
import { readActivitySummary } from '../activity';
import { results } from '../db/schema';
import {
  authenticated,
  authRateLimit,
  notBanned,
  sameOrigin,
  zodReject,
  type HttpEnv,
} from './context';
import { revokeSession } from './revocation';

function cookieAttributes(c: Context<HttpEnv>) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: new URL(c.get('services').config.publicOrigin).protocol === 'https:',
  };
}

function issueSessionCookie(c: Context<HttpEnv>, ticket: SessionTicket): void {
  setCookie(c, SESSION_COOKIE, ticket.token, {
    ...cookieAttributes(c),
    maxAge: Math.max(0, Math.floor((ticket.expiresAt - Date.now()) / 1000)),
  });
}

export const accountRoutes = new Hono<HttpEnv>({ strict: false })
  .get('/session', async (c) => {
    const { database } = c.get('services');
    const session = await loadSession(database, sessionHashFromToken(getCookie(c, SESSION_COOKIE)));
    const body: SessionInfo = {
      user: session?.user ?? null,
      role: session?.role ?? null,
      ban: session?.ban ?? null,
    };
    return c.json(body);
  })
  .get('/activity', async (c) => {
    let activity: ActivitySummary;
    try {
      activity = await readActivitySummary(c.get('services').database);
    } catch {
      throw new HTTPException(503, { message: '活动数据暂时不可用，请稍后再试。' });
    }
    return c.json(activity);
  })
  .get(
    '/auth/wechat/start',
    authRateLimit('wechat-start'),
    zValidator('query', z.object({ room: roomIdSchema.optional() }), zodReject),
    async (c) => {
      const { database, config } = c.get('services');
      const roomId = c.req.valid('query').room ?? null;
      if (!config.wechatBridge) {
        const failure = new URL('/auth', config.publicOrigin);
        failure.searchParams.set('error', 'wechat_unavailable');
        if (roomId) failure.searchParams.set('room', roomId);
        return c.redirect(failure.pathname + failure.search);
      }
      const login = await beginWechatLogin(database, config, roomId);
      setCookie(c, WECHAT_STATE_COOKIE, login.state, {
        ...cookieAttributes(c),
        maxAge: WECHAT_STATE_TTL_SECONDS,
      });
      return c.redirect(login.url);
    },
  )
  .get('/auth/wechat/callback', authRateLimit('wechat-callback'), async (c) => {
    const { database, config } = c.get('services');
    c.header('Referrer-Policy', 'no-referrer');
    const failure = new URL('/auth', config.publicOrigin);
    failure.searchParams.set('error', 'wechat_failed');
    const state = c.req.query('state');
    const cookie = getCookie(c, WECHAT_STATE_COOKIE);
    deleteCookie(c, WECHAT_STATE_COOKIE, cookieAttributes(c));
    try {
      if (!state || !WECHAT_STATE_PATTERN.test(state) || state !== cookie)
        throw new HTTPException(401);
      const attempt = await consumeWechatAttempt(database, state);
      if (attempt.room_id) failure.searchParams.set('room', attempt.room_id);
      const token = c.req.query('token');
      if (!token || c.req.query('wx_bridge_error')) throw new HTTPException(401);
      const ticket = await finishWechatLogin(database, config, token);
      issueSessionCookie(c, ticket);
      const destination = new URL('/', config.publicOrigin);
      if (attempt.room_id) destination.searchParams.set('room', attempt.room_id);
      return c.redirect(destination.pathname + destination.search);
    } catch (error) {
      if (!(error instanceof HTTPException))
        console.error('WeChat login could not establish a session.');
      return c.redirect(failure.pathname + failure.search);
    }
  })
  .post('/logout', sameOrigin, async (c) => {
    const tokenHash = sessionHashFromToken(getCookie(c, SESSION_COOKIE));
    if (tokenHash) await revokeSession(c.get('services'), tokenHash);
    deleteCookie(c, SESSION_COOKIE, cookieAttributes(c));
    return c.json({ ok: true as const });
  })
  .get('/profile', authenticated, notBanned, async (c) => {
    const user = c.get('session').user;
    const { database } = c.get('services');
    const [stats] = await database
      .select({
        games: count(),
        wins: sql<number>`coalesce(sum(case when ${results.rank} = 1 then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
        bestCpm: sql<number>`coalesce(max(${results.cpm}), 0)`.mapWith(Number),
      })
      .from(results)
      .where(eq(results.user_id, user.id));
    const history = await database
      .select({
        match_id: results.match_id,
        theme: results.theme,
        opponent_kind: results.opponent_kind,
        damage_dealt: results.damage_dealt,
        hp_remaining: results.hp_remaining,
        spells_cast: results.spells_cast,
        correct_chars: results.correct_chars,
        duration_ms: results.duration_ms,
        rank: results.rank,
        cpm: results.cpm,
        accuracy: results.accuracy,
        created_at: results.created_at,
        input_policy_version: results.input_policy_version,
        input_policy_mode: results.input_policy_mode,
        input_gate_hits: results.input_gate_hits,
        input_recoveries: results.input_recoveries,
        input_min_completion_ratio: results.input_min_completion_ratio,
        input_overloads: results.input_overloads,
        input_recovered_completions: results.input_recovered_completions,
        input_recovery_departures: results.input_recovery_departures,
      })
      .from(results)
      .where(eq(results.user_id, user.id))
      .orderBy(desc(results.created_at), desc(results.match_id))
      .limit(10);
    const body: Profile = {
      user,
      stats: {
        games: Number(stats?.games ?? 0),
        wins: Number(stats?.wins ?? 0),
        bestCpm: Number(stats?.bestCpm ?? 0),
      },
      history,
    };
    return c.json(body);
  });
