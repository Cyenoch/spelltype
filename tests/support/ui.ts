/**
 * Browser-level helpers shared by the specs: accounts, the lobby, the room shell, the profile and
 * the wire. Everything here drives the real UI contract (data-testid attributes and accessible
 * names) or the public HTTP API, so the suite observes the same surface a player does. Battle
 * surface and completion drivers live in `combat.ts`.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RoomSnapshot } from '../../shared/protocol';
import { trackAccountForQueueCleanup } from './accounts';
import { runtime } from './runtime';

export const PASSWORD = 'spelltype-e2e-pw';
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

let accountCounter = 0;

/** Unique, charset-safe account name (2–20 chars, ASCII letters/digits/underscore). */
export function uniqueName(prefix = 'p'): string {
  accountCounter += 1;
  return `${prefix}${Date.now().toString(36)}${accountCounter.toString(36)}`.slice(0, 20);
}

export async function newContext(
  browser: Browser,
  options: { viewport?: { width: number; height: number }; reducedMotion?: 'reduce' | 'no-preference'; baseUrl?: string } = {},
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: options.viewport ?? DESKTOP_VIEWPORT,
    locale: 'zh-CN',
    reducedMotion: options.reducedMotion,
    baseURL: options.baseUrl ?? runtime().appUrl,
  });
}

export function testId(page: Page, id: string) {
  return page.getByTestId(id);
}

export async function gotoApp(page: Page, pathname = '/'): Promise<void> {
  await page.goto(pathname, { waitUntil: 'domcontentloaded' });
  await expect(testId(page, 'app-root')).toBeVisible();
}

/** Opens the app and waits until the home view is interactive. */
export async function openHome(page: Page): Promise<void> {
  await gotoApp(page);
  await expect(testId(page, 'view-home')).toBeVisible();
}

export async function openAuth(page: Page): Promise<void> {
  if (await testId(page, 'view-auth').isVisible()) return;
  const navAuth = testId(page, 'nav-auth');
  if (await navAuth.isVisible()) await navAuth.click();
  else await testId(page, 'home-auth').click();
  await expect(testId(page, 'view-auth')).toBeVisible();
}

export async function signUp(page: Page, username: string, password = PASSWORD): Promise<void> {
  await openAuth(page);
  await testId(page, 'auth-mode-register').click();
  await testId(page, 'auth-username').fill(username);
  await testId(page, 'auth-password').fill(password);
  await testId(page, 'auth-submit').click();
  await expect(testId(page, 'nav-username')).toHaveText(username);
  await trackAccountForQueueCleanup(page.context(), new URL(page.url()).origin);
}

export async function signIn(page: Page, username: string, password = PASSWORD): Promise<void> {
  await openAuth(page);
  await testId(page, 'auth-mode-login').click();
  await testId(page, 'auth-username').fill(username);
  await testId(page, 'auth-password').fill(password);
  await testId(page, 'auth-submit').click();
  await expect(testId(page, 'nav-username')).toHaveText(username);
  await trackAccountForQueueCleanup(page.context(), new URL(page.url()).origin);
}

/** The signed-out invariant, read from the persistent topbar. */
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(testId(page, 'nav-username')).toBeHidden();
  await expect(testId(page, 'sign-out')).toBeHidden();
  await expect(testId(page, 'nav-auth')).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await testId(page, 'sign-out').click();
  await expectSignedOut(page);
}

/** A signed-in browser session: its context, its first page and the account name. */
export interface Session {
  context: BrowserContext;
  page: Page;
  username: string;
}

/** Registers a fresh account in a fresh context and returns both. */
export async function signedInContext(browser: Browser, prefix = 'p'): Promise<Session> {
  const context = await newContext(browser);
  const page = await context.newPage();
  const username = uniqueName(prefix);
  await openHome(page);
  await signUp(page, username);
  return { context, page, username };
}

export async function createRoom(page: Page, options: { theme?: string; difficulty?: 'easy' | 'normal' | 'hard'; preset?: number }): Promise<string> {
  await testId(page, 'home-create').click();
  await expect(testId(page, 'view-create')).toBeVisible();
  if (options.preset !== undefined) await testId(page, 'theme-preset').nth(options.preset).click();
  if (options.theme !== undefined) await testId(page, 'room-theme-input').fill(options.theme);
  await testId(page, 'room-difficulty').selectOption(options.difficulty ?? 'normal');
  await testId(page, 'room-create-submit').click();
  await expect(testId(page, 'view-room')).toBeVisible();
  await expect(testId(page, 'lobby-panel')).toBeVisible();
  const roomId = (await testId(page, 'lobby-room-id').textContent())?.trim() ?? '';
  expect(roomId).toMatch(/^[0-9a-f]{24}$/);
  return roomId;
}

/** The invite link a host copies out of the lobby. */
export async function inviteUrl(page: Page): Promise<string> {
  const value = await testId(page, 'lobby-invite-link').inputValue();
  expect(value).toContain('/?room=');
  return value;
}

/**
 * Occupied seats only. The lobby always renders its full capacity (2 for quick, 4 for a
 * private room) and marks empty ones with an empty `data-user`, so seating assertions must
 * never count bare `lobby-slot` nodes.
 */
export function occupiedSeats(page: Page) {
  return page.locator('[data-testid="lobby-slot"][data-user]:not([data-user=""])');
}

export function occupiedSeat(page: Page, username: string) {
  return occupiedSeats(page).filter({ hasText: username });
}

/** Waits until the lobby shows `count` occupied slots (by username text). */
export async function waitForLobbyPlayers(page: Page, usernames: string[], timeout = 30_000): Promise<void> {
  // The seat label of the viewer's own account carries a （你） suffix; empty seats are
  // excluded by the occupied-seat selector rather than by matching their wording.
  await expect
    .poll(
      async () =>
        (await occupiedSeats(page).locator('[data-testid="lobby-slot-name"]').allTextContents())
          .map((text) => text.replace(/（你）$/, '').trim())
          .filter(Boolean)
          .sort()
          .join(','),
      { timeout },
    )
    .toBe([...usernames].sort().join(','));
}

export async function setReady(page: Page, ready = true): Promise<void> {
  const button = testId(page, 'lobby-ready');
  const current = await button.getAttribute('aria-pressed');
  if ((current === 'true') !== ready) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(ready));
}

/** Host clicks start; the battle panel mounting is what "the match started" means. */
export async function startMatch(page: Page): Promise<void> {
  await testId(page, 'lobby-start').click();
  await expect(testId(page, 'battle-panel')).toBeVisible({ timeout: 30_000 });
}


/** A player identity: display name plus the account id, whichever the DOM reports. */
export interface Identity {
  username: string;
  userId: string;
}

export async function selfIdentity(context: BrowserContext): Promise<Identity> {
  const response = await context.request.get('/api/session');
  const body = (await response.json()) as { user: { id: string; username: string } | null };
  if (!body.user) throw new Error('no authenticated user in this context');
  return { username: body.user.username, userId: body.user.id };
}

/** Matches a rendered row whether the DOM keys players by id, by name or by label text. */
export function rowFor<T extends { user: string; text?: string }>(rows: T[], identity: Identity): T | undefined {
  return rows.find(
    (row) => row.user === identity.userId || row.user === identity.username || (row.text ?? '').includes(identity.username),
  );
}

/**
 * Normalises an accuracy figure to percent: the protocol carries a number, which may be a
 * 0–1 ratio or already a percentage.
 */
export function accuracyPercent(value: number | string): number {
  const numeric = typeof value === 'number' ? value : Number(value.replace(/[^\d.]/g, ''));
  return numeric <= 1 ? numeric * 100 : numeric;
}

/** True for any accuracy rendering that carries a real figure (not a placeholder). */
export function hasNumber(value: string): boolean {
  return /\d/.test(value);
}

/** Waits for a fixed wall-clock delay (used after a write that has no observable completion). */
export function settle(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Sends raw room frames over a fresh socket (used for replay/cut-off input checks). */
export async function sendRawMessages(page: Page, roomId: string, messages: unknown[]): Promise<void> {
  await page.evaluate(
    ({ roomId: id, messages: payload }) =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/api/rooms/${id}/ws`);
        socket.onopen = () => {
          for (const message of payload) socket.send(JSON.stringify(message));
          setTimeout(() => {
            socket.close();
            resolve();
          }, 1200);
        };
        socket.onerror = () => resolve();
        socket.onclose = () => resolve();
        setTimeout(() => resolve(), 8000);
      }),
    { roomId, messages },
  );
}

export interface RoomOptions {
  theme?: string;
  difficulty?: 'easy' | 'normal' | 'hard';
  preset?: number;
  ready?: boolean;
  sockets?: boolean;
}

async function seatPlayers(browser: Browser, count: number, options: RoomOptions) {
  const sessions: Session[] = [];
  const socketCaptures: (SocketCapture | undefined)[] = [];
  for (let index = 0; index < count; index += 1) {
    const session = await signedInContext(browser, index === 0 ? 'host' : `guest${index}`);
    sessions.push(session);
    socketCaptures.push(options.sockets ? captureSockets(session.page) : undefined);
  }
  const [host, ...guests] = sessions;
  const roomId = await createRoom(host.page, options);
  for (const guest of guests) {
    await gotoApp(guest.page, `/?room=${roomId}`);
    await expect(testId(guest.page, 'lobby-panel')).toBeVisible({ timeout: 30_000 });
  }
  await waitForLobbyPlayers(host.page, sessions.map((session) => session.username));
  if (options.ready !== false) for (const guest of guests) await setReady(guest.page, true);
  return { sessions, socketCaptures, roomId };
}

/** Creates a private room with `count` signed-in players (guests already ready). */
export async function seatedRoom(browser: Browser, count: number, options: RoomOptions = {}) {
  const { sessions, socketCaptures, roomId } = await seatPlayers(browser, count, options);
  const [host, ...guests] = sessions;
  return { host, guests, sessions, roomId, hostSockets: socketCaptures[0], guestSockets: socketCaptures.slice(1) };
}

/** Creates a private room with two signed-in players (guest already ready) and returns it. */
export async function twoPlayerRoom(
  browser: Browser,
  options: RoomOptions = {},
): Promise<{ host: Session; guest: Session; roomId: string; hostSockets?: SocketCapture; guestSockets?: SocketCapture }> {
  const room = await seatedRoom(browser, 2, options);
  return { host: room.host, guest: room.guests[0], roomId: room.roomId, hostSockets: room.hostSockets, guestSockets: room.guestSockets[0] };
}

export interface SocketCapture {
  frames: { at: number; direction: 'sent' | 'received'; payload: string }[];
}

/**
 * Records WebSocket close codes for the page's own sockets. Must be installed before the
 * page navigates (the single-page app loads once). Test-side observation only: nothing is
 * added to the product.
 */
export async function captureCloseCodes(page: Page): Promise<() => Promise<number[]>> {
  await page.addInitScript(() => {
    const codes: number[] = [];
    (window as unknown as { __wsCloseCodes: number[] }).__wsCloseCodes = codes;
    const Original = window.WebSocket;
    class Tracked extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        this.addEventListener('close', (event) => codes.push((event as CloseEvent).code));
      }
    }
    window.WebSocket = Tracked as unknown as typeof WebSocket;
  });
  return async () => page.evaluate(() => (window as unknown as { __wsCloseCodes?: number[] }).__wsCloseCodes ?? []);
}

/**
 * Records every WebSocket frame on the page (both directions). Attach this BEFORE the page
 * navigates or connects: only sockets created after the listener is attached are captured.
 */
export function captureSockets(page: Page): SocketCapture {
  const capture: SocketCapture = { frames: [] };
  page.on('websocket', (socket) => {
    socket.on('framesent', (event) => capture.frames.push({ at: Date.now(), direction: 'sent', payload: String(event.payload) }));
    socket.on('framereceived', (event) => capture.frames.push({ at: Date.now(), direction: 'received', payload: String(event.payload) }));
  });
  return capture;
}

export function capturedText(capture: SocketCapture): string {
  return capture.frames.map((frame) => frame.payload).join('\n');
}


/** Only what the server sent to this page: the authoritative privacy boundary. */
export function receivedText(capture: SocketCapture): string {
  return capture.frames.filter((frame) => frame.direction === 'received').map((frame) => frame.payload).join('\n');
}

export interface ReceivedFrame {
  at: number;
  payload: string;
  /** The room payload when the frame was a state message, else undefined. */
  room?: RoomSnapshot;
  message: { type?: string; message?: string; room?: RoomSnapshot; serverNow?: number };
}

/** Parsed server frames, so phase and combat state can be judged from the payload itself. */
export function receivedFrames(capture: SocketCapture): ReceivedFrame[] {
  return capture.frames
    .filter((frame) => frame.direction === 'received')
    .map((frame) => {
      let message: ReceivedFrame['message'] = {};
      try {
        message = JSON.parse(frame.payload) as ReceivedFrame['message'];
      } catch {
        message = {};
      }
      return { at: frame.at, payload: frame.payload, room: message.room, message };
    });
}

export function sentFrames(capture: SocketCapture): string[] {
  return capture.frames.filter((frame) => frame.direction === 'sent').map((frame) => frame.payload);
}

/** Parsed client frames, so a spec can assert on the exact input contract it sent. */
export interface SentFrame {
  type?: string;
  matchId?: string;
  spellIndex?: number;
  text?: string;
}

export function sentMessages(capture: SocketCapture): SentFrame[] {
  return sentFrames(capture).map((frame) => {
    try {
      return JSON.parse(frame) as SentFrame;
    } catch {
      return {};
    }
  });
}

/** All error text the player can actually see right now (never console-only). */
export async function visibleErrorText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const id of ['room-error', 'create-error', 'auth-error', 'queue-error', 'toast', 'graphics-warning']) {
    const locator = testId(page, id);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const element = locator.nth(index);
      if (await element.isVisible()) parts.push(((await element.textContent()) ?? '').trim());
    }
  }
  return parts.filter((part) => part.length > 0).join(' | ');
}

export async function apiJson<T>(
  context: BrowserContext,
  url: string,
  init?: { method?: string; data?: unknown; origin?: string },
): Promise<{ status: number; body: T }> {
  // Relative paths target the main test instance; pass an absolute URL for the no-key one.
  const absolute = /^https?:/.test(url) ? url : new URL(url, runtime().appUrl).toString();
  const response = await context.request.fetch(absolute, {
    method: init?.method ?? 'GET',
    data: init?.data,
    // The app rejects state-changing requests without a same-host, same-scheme Origin.
    headers: { origin: init?.origin ?? new URL(absolute).origin },
    failOnStatusCode: false,
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : null) as T };
}

/* --------------------------------------------------------------- profile */

/**
 * Opens the profile view and waits for its data load to finish. The view and its stat tiles are
 * rendered synchronously (the games tile starts as a placeholder), so the load is observed via the
 * loading indicator, the error text and the games figure becoming numeric.
 */
export async function openProfile(page: Page): Promise<void> {
  if (!(await testId(page, 'home-profile').isVisible())) await gotoApp(page);
  await testId(page, 'home-profile').click();
  await waitForProfileLoaded(page);
}

/** The profile has finished loading when the spinner is gone, no error is shown and games is numeric. */
export async function waitForProfileLoaded(page: Page): Promise<void> {
  await expect(testId(page, 'view-profile')).toBeVisible();
  await expect(testId(page, 'profile-stats')).toBeVisible();
  await expect(testId(page, 'profile-loading')).toBeHidden({ timeout: 30_000 });
  await expect(testId(page, 'profile-error')).toBeHidden();
  await expect
    .poll(async () => /^\d/.test(((await testId(page, 'profile-games').textContent()) ?? '').trim()), { timeout: 30_000 })
    .toBe(true);
}

export interface HistoryRow {
  matchId: string;
  theme: string;
  /** Combat damage dealt by this player, as a plain figure. */
  damage: number | null;
  /** Remaining health when the match settled. */
  hp: number | null;
  /** Spells this player completed. */
  spells: number | null;
  rank: number;
  cpm: number;
  accuracy: string;
  created: string;
  text: string;
}

/** A cell's figure, but only when the cell is nothing but that figure. */
function bareNumber(text: string): number | null {
  const raw = text.trim();
  return /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
}

export async function historyRows(page: Page): Promise<HistoryRow[]> {
  // Never read the table before the asynchronous load settled (a zero-row account is valid).
  await waitForProfileLoaded(page);
  const rows = await testId(page, 'history-row').all();
  return Promise.all(
    rows.map(async (row) => {
      const textOf = async (id: string) => ((await row.getByTestId(id).textContent()) ?? '').trim();
      return {
        matchId: (await row.getAttribute('data-match-id')) ?? '',
        theme: await textOf('history-theme'),
        damage: bareNumber(await textOf('history-damage')),
        hp: bareNumber(await textOf('history-hp')),
        spells: bareNumber(await textOf('history-spells')),
        rank: Number((await textOf('history-rank')).replace(/[^\d-]/g, '') || 'NaN'),
        cpm: Number((await textOf('history-cpm')).replace(/[^\d-]/g, '') || 'NaN'),
        accuracy: await textOf('history-accuracy'),
        created: await textOf('history-created'),
        text: ((await row.textContent()) ?? '').trim(),
      };
    }),
  );
}
