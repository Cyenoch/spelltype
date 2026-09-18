/**
 * The private room as a player sees it: the create form, the invite link, the seats, readiness and
 * the host's start, plus the seating helpers that assemble a real room out of fresh accounts.
 */
import { expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './app';
import { signedInContext, type Session } from './session';
import { captureSockets, type SocketCapture } from './wire';

export async function createRoom(
  page: Page,
  options: { theme?: string; preset?: number },
): Promise<string> {
  await page.getByTestId('home-create').click();
  await expect(page.getByTestId('view-create')).toBeVisible();
  if (options.preset !== undefined)
    await page.getByTestId('theme-preset').nth(options.preset).click();
  if (options.theme !== undefined) await page.getByTestId('room-theme-input').fill(options.theme);
  await page.getByTestId('room-create-submit').click();
  await expect(page.getByTestId('view-room')).toBeVisible();
  await expect(page.getByTestId('lobby-panel')).toBeVisible();
  const roomId = (await page.getByTestId('lobby-room-id').textContent())?.trim() ?? '';
  expect(roomId).toMatch(/^[0-9a-f]{24}$/);
  return roomId;
}

/** The invite link a host copies out of the lobby. */
export async function inviteUrl(page: Page): Promise<string> {
  const value = await page.getByTestId('lobby-invite-link').inputValue();
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

/** Waits until the lobby shows exactly these occupied seats (by username text). */
export async function waitForLobbyPlayers(
  page: Page,
  usernames: string[],
  timeout = 30_000,
): Promise<void> {
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
  const button = page.getByTestId('lobby-ready');
  const current = await button.getAttribute('aria-pressed');
  if ((current === 'true') !== ready) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(ready));
}

/** Host clicks start; the battle panel mounting is what "the match started" means. */
export async function startMatch(page: Page): Promise<void> {
  await page.getByTestId('lobby-start').click();
  await expect(page.getByTestId('battle-panel')).toBeVisible({ timeout: 30_000 });
}

export interface RoomOptions {
  theme?: string;
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
    await expect(guest.page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  }
  await waitForLobbyPlayers(
    host.page,
    sessions.map((session) => session.username),
  );
  if (options.ready !== false) for (const guest of guests) await setReady(guest.page, true);
  return { sessions, socketCaptures, roomId };
}

/** Creates a private room with `count` signed-in players (guests already ready). */
export async function seatedRoom(browser: Browser, count: number, options: RoomOptions = {}) {
  const { sessions, socketCaptures, roomId } = await seatPlayers(browser, count, options);
  const [host, ...guests] = sessions;
  return {
    host,
    guests,
    sessions,
    roomId,
    hostSockets: socketCaptures[0],
    guestSockets: socketCaptures.slice(1),
  };
}

/** Creates a private room with two signed-in players (guest already ready) and returns it. */
export async function twoPlayerRoom(
  browser: Browser,
  options: RoomOptions = {},
): Promise<{
  host: Session;
  guest: Session;
  roomId: string;
  hostSockets?: SocketCapture;
  guestSockets?: SocketCapture;
}> {
  const room = await seatedRoom(browser, 2, options);
  return {
    host: room.host,
    guest: room.guests[0],
    roomId: room.roomId,
    hostSockets: room.hostSockets,
    guestSockets: room.guestSockets[0],
  };
}
