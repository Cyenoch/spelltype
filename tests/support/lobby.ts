/**
 * 玩家视角下的私人房间：创建表单、房间 ID 邀请码、席位、准备状态与房主开局，
 * 以及将新账号组装入真实房间的入座辅助函数。
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

/**
 * 仅已占用的席位。大厅始终渲染其完整容量（快速匹配为 2，私人房间为 4），
 * 并将空位标记为空的 `data-user`，因此席位断言决不能直接统计光秃秃的 `lobby-slot` 节点。
 */
export function occupiedSeats(page: Page) {
  return page.locator('[data-testid="lobby-slot"][data-user]:not([data-user=""])');
}

export function occupiedSeat(page: Page, username: string) {
  return occupiedSeats(page).filter({ hasText: username });
}

/** 等待直到大厅按用户名文本展示指定的已占用席位。 */
export async function waitForLobbyPlayers(
  page: Page,
  usernames: string[],
  timeout = 30_000,
): Promise<void> {
  // 查看者自身账号的席位标签带有 （你） 后缀；
  // 空席位通过已占用席位选择器排除，而不是通过匹配文案排除。
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

/** 房主点击开始；战斗面板挂载即代表“比赛开始”。 */
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

/** 创建一个拥有 `count` 名已登录玩家的私人房间（访客已处于准备状态）。 */
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

/** 创建一个拥有两名已登录玩家的私人房间（访客已处于准备状态）并返回。 */
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
