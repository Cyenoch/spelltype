import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type {
  AdminBookDetail,
  AdminMatch,
  AdminMatchDetail,
  AdminPage,
  AdminUser,
  AdminUserDetail,
  AdminOverview,
} from '../../shared/admin';
import {
  accounts,
  openDatabase,
  players,
  results,
  rooms,
  spellBookCache,
  type OpenedDatabase,
} from '../../server/db';
import { createSession, SESSION_COOKIE } from '../../server/auth/sessions';
import { createApp, type AppType } from '../../server/http/app';
import type { ServerConfig } from '../../server/config';

const roomId = 'a123456789abcdef01234567';
const oldMatch = 'old-match';
const liveMatch = 'live-match';
const oldTheme = '历史主题';
const theme = '当前主题';
const now = Date.now();
let database: OpenedDatabase;
let adminCookie: string;
let app: Pick<AppType, 'request'>;
let userCookie: string;
const config: ServerConfig = {
  buildId: 'admin-test',
  databaseUrl: 'pglite://:memory:',
  hostname: '127.0.0.1',
  port: 0,
  publicOrigin: 'https://app.example',
  maintenanceToken: null,
  assetsRoot: null,
  ai: { apiKey: null, model: 'test' },
  authLimits: { attempts: 1000, windowMs: 60_000 },
  trustForwardedFor: false,
  wechatBridge: null,
  inputPolicyMode: 'observe',
};

beforeAll(async () => {
  database = await openDatabase('pglite://:memory:');
  const db = database.db;
  await db.insert(accounts).values([
    {
      id: 'admin',
      username: '管理员',
      role: 'admin',
      wechat_identity: 'secret-admin-identity',
      created_at: now,
    },
    ...Array.from({ length: 23 }, (_, index) => ({
      id: `user-${index}`,
      username: index === 0 ? '百分%玩家' : `用户${index}`,
      wechat_identity: `secret-user-${index}`,
      created_at: now - index,
    })),
  ]);
  adminCookie = `${SESSION_COOKIE}=${(await createSession(db, 'admin')).token}`;
  userCookie = `${SESSION_COOKIE}=${(await createSession(db, 'user-0')).token}`;
  await db.insert(rooms).values({
    id: roomId,
    host_id: 'user-1',
    mode: 'private',
    theme,
    difficulty: 'hard',
    phase: 'playing',
    match_id: liveMatch,
    started_at: now,
    deadline: now + 240_000,
    created_at: now - 100_000,
    updated_at: now,
    opponent_kind: 'bot',
    spell_book: JSON.stringify([
      {
        name: '当前快照',
        text: 'Current battle spell.',
        translation: '当前对局咒文。',
        element: 'arcane',
      },
    ]),
  });
  await db.insert(players).values([
    {
      room_id: roomId,
      user_id: 'user-1',
      username: '当前玩家',
      slot: 0,
      joined_at: now,
      seated: 1,
    },
    {
      room_id: roomId,
      user_id: 'bot-seat',
      username: '训练对手',
      slot: 1,
      joined_at: now,
      seated: 1,
    },
  ]);
  await db.insert(results).values([
    {
      match_id: oldMatch,
      user_id: 'user-0',
      room_id: roomId,
      theme: oldTheme,
      opponent_kind: 'human',
      damage_dealt: 100,
      hp_remaining: 200,
      spells_cast: 2,
      correct_chars: 30,
      duration_ms: 60_000,
      rank: 1,
      cpm: 30,
      accuracy: null,
      created_at: now - 20_000,
    },
    {
      match_id: oldMatch,
      user_id: 'user-2',
      room_id: roomId,
      theme: oldTheme,
      opponent_kind: 'human',
      damage_dealt: 50,
      hp_remaining: 0,
      spells_cast: 1,
      correct_chars: 20,
      duration_ms: 60_000,
      rank: 2,
      cpm: 20,
      accuracy: 0.8,
      created_at: now - 20_000,
    },
  ]);
  await db.insert(spellBookCache).values([
    {
      theme,
      book: [
        {
          name: '当前缓存',
          text: 'A new cached spell.',
          translation: '新缓存咒文。',
          element: 'ice',
        },
      ],
      published_at: now,
    },
    {
      theme: oldTheme,
      book: [
        {
          name: '历史主题的新版本',
          text: 'Not the old match snapshot.',
          translation: '不是历史对局快照。',
          element: 'fire',
        },
      ],
      published_at: now,
    },
  ]);
  app = createApp({ database: db, config, rooms: null });
});
afterAll(async () => {
  await database?.close();
});

function request(path: string, cookie = adminCookie) {
  return app.request(`/api/admin${path}`, { headers: { cookie } });
}

describe('administration data boundaries', () => {
  it('requires a fresh administrator role for every list and detail, not a maintenance bearer token', async () => {
    const paths = [
      '/overview',
      '/users',
      '/users/user-0',
      '/matches',
      `/matches/${oldMatch}`,
      '/books',
      `/books/${encodeURIComponent(theme)}`,
    ];
    for (const path of paths) {
      expect((await request(path, '')).status).toBe(401);
      expect((await request(path, userCookie)).status).toBe(403);
      expect(
        (
          await app.request(`/api/admin${path}`, {
            headers: { authorization: 'Bearer pretend-admin' },
          })
        ).status,
      ).toBe(401);
    }
    await database.db.update(accounts).set({ role: 'user' }).where(eq(accounts.id, 'admin'));
    try {
      expect((await request('/overview')).status).toBe(403);
    } finally {
      await database.db.update(accounts).set({ role: 'admin' }).where(eq(accounts.id, 'admin'));
    }
  });

  it('keeps a historical match independent of its reused room and current book', async () => {
    const response = await request(`/matches/${oldMatch}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as AdminMatchDetail;
    expect(detail.match).toMatchObject({
      id: oldMatch,
      roomId,
      theme: oldTheme,
      phase: 'finished',
      opponentKind: 'human',
    });
    expect(detail.isCurrentRoomMatch).toBe(false);
    expect(detail.spellBook).toBeNull();
    expect(detail.endReason).toBeNull();
    expect(detail.participants.map((participant) => participant.userId).sort()).toEqual([
      'user-0',
      'user-2',
    ]);
    expect(detail.currentBookTheme).toBe(oldTheme);
    expect(detail.results[0]).toMatchObject({ userId: 'user-0', accuracy: null, rank: 1 });
    const profile = (await (await request('/users/user-0')).json()) as AdminUserDetail;
    expect(profile.stats).toMatchObject({ games: 1, wins: 1, bestCpm: 30, averageAccuracy: null });
    expect(profile.history.items[0]?.match_id).toBe(oldMatch);
    expect(profile.activeRoom).toBeNull();
    const book = (await (
      await request(`/books/${encodeURIComponent(oldTheme)}`)
    ).json()) as AdminBookDetail;
    expect(book.matches.items.map((match) => match.id)).toEqual([oldMatch]);
    expect(book.spells[0]?.name).toBe('历史主题的新版本');
  });

  it('returns real account links only and counts matches rather than participant results', async () => {
    const current = (await (await request(`/matches/${liveMatch}`)).json()) as AdminMatchDetail;
    expect(current.isCurrentRoomMatch).toBe(true);
    expect(current.spellBook?.[0]?.name).toBe('当前快照');
    expect(
      current.participants.find((participant) => participant.userId === 'bot-seat')?.accountExists,
    ).toBe(false);
    expect(
      current.participants.find((participant) => participant.userId === 'user-1')?.accountExists,
    ).toBe(true);
    const overview = (await (await request('/overview')).json()) as AdminOverview;
    expect(overview).toMatchObject({
      users: 24,
      admins: 1,
      matches: 2,
      activeMatches: 1,
      books: 2,
    });
  });

  it('paginates deterministically, treats search wildcards literally, and rejects invalid requests without leaking secrets', async () => {
    const firstResponse = await request('/users?page=1');
    expect(firstResponse.headers.get('cache-control')).toContain('no-store');
    const first = (await firstResponse.json()) as AdminPage<AdminUser>;
    const second = (await (await request('/users?page=2')).json()) as AdminPage<AdminUser>;
    expect(first.total).toBe(24);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(4);
    expect(new Set([...first.items, ...second.items].map((user) => user.id)).size).toBe(24);
    const filtered = (await (await request('/users?q=%25')).json()) as AdminPage<AdminUser>;
    expect(filtered.items.map((user) => user.id)).toEqual(['user-0']);
    const data = JSON.stringify(first);
    expect(data).not.toContain('wechat_identity');
    expect(data).not.toContain('secret-admin-identity');
    for (const path of ['/users?page=-1', '/users?page=1.5', '/matches?phase=invalid'])
      expect((await request(path)).status).toBe(400);
    for (const path of ['/users/missing', '/matches/missing', '/books/missing'])
      expect((await request(path)).status).toBe(404);
  });

  it('paginates the combined live and historical match stream without skipping a boundary record', async () => {
    const extraIds = Array.from({ length: 20 }, (_, index) => `pagination-${index}`);
    await database.db.insert(results).values(
      extraIds.map((id, index) => ({
        match_id: id,
        user_id: 'user-0',
        room_id: roomId,
        theme: oldTheme,
        damage_dealt: 10,
        hp_remaining: 0,
        spells_cast: 1,
        correct_chars: 10,
        duration_ms: 1000,
        rank: 2,
        cpm: 10,
        accuracy: 0.9,
        created_at: now - 200_000 - index,
      })),
    );
    const first = (await (await request('/matches?page=1')).json()) as AdminPage<AdminMatch>;
    const second = (await (await request('/matches?page=2')).json()) as AdminPage<AdminMatch>;
    expect(first.total).toBe(22);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(2);
    expect([...first.items, ...second.items].map((match) => match.id).sort()).toEqual(
      [oldMatch, liveMatch, ...extraIds].sort(),
    );
    expect(first.items.at(-1)!.createdAt).toBeGreaterThanOrEqual(second.items[0].createdAt);
  });
});
