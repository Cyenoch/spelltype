/**
 * Client protocol-ordering and corruption boundary, driven through the real room surface.
 *
 * The page's own WebSocket is subclassed before its first document load so a test can reach the
 * one live room socket. Authoritative state that the server really sent is captured from the
 * wire, doctored in the test, and replayed INTO the client with `socket.dispatchEvent` — an
 * injected probe that exercises only the client's ordering and validation rules (stale
 * snapshots, mid-composition identity changes, gate-less states, version mismatch). There is no
 * production hook for this; every injection below is marked as one.
 *
 * What this file proves that wire-level tests cannot: the field, the gate indicator and the
 * binding react exactly as the protocol contract demands when snapshots arrive out of order or
 * malformed, and a stale HTTP verdict that lands after a newer connection can never clobber it.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test } from '../support/test';
import type { Player, RoomSnapshot } from '../../shared/protocol';
import { apiJson } from '../support/api';
import { gotoApp, settle } from '../support/app';
import {
  battleMatchId,
  battlePhase,
  completeSpell,
  gateIndicator,
  inputValue,
  roomSnapshot,
  spellText,
  typingInput,
  waitForCombat,
} from '../support/combat';
import { createRoom, setReady, startMatch, waitForLobbyPlayers } from '../support/lobby';
import { fixture } from '../support/runtime';
import { captureSockets, sentMessages, type SocketCapture } from '../support/wire';
import { newContext, signUp, signedInContext, uniqueName, type Session } from '../support/session';

declare global {
  interface Window {
    /** The page's most recently opened WebSocket, installed before the first document load. */
    __spelltypeSocket?: WebSocket;
    __spelltypeSockets?: WebSocket[];
  }
}

test.beforeEach(async () => {
  await fixture().reset();
});

/* ------------------------------------------------------------- local helpers */

interface SnapshotFeed {
  latest(): RoomSnapshot | null;
}

/** Tracks every server frame from now on and keeps the newest authoritative snapshot. */
function snapshotFeed(page: Page): SnapshotFeed {
  let latest: RoomSnapshot | null = null;
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => {
      try {
        const parsed = JSON.parse(String(event.payload)) as { type?: string; room?: RoomSnapshot };
        if (parsed.type === 'state' && parsed.room) latest = parsed.room;
      } catch {
        /* framing noise */
      }
    });
  });
  return { latest: () => latest };
}

/** The self player row of a snapshot. */
function selfOf(snapshot: RoomSnapshot, selfId: string): Player {
  const player = snapshot.players.find((entry) => entry.id === selfId);
  if (!player) throw new Error(`snapshot has no player ${selfId}`);
  return player;
}

/** Waits until the feed has captured a snapshot satisfying `when`. */
async function capturedSnapshot(
  feed: SnapshotFeed,
  when: (snapshot: RoomSnapshot) => boolean,
): Promise<RoomSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = feed.latest();
    if (snapshot && when(snapshot)) return snapshot;
    await settle(100);
  }
  throw new Error('no matching server snapshot was captured');
}

/**
 * INJECTED PROBE: replays `snapshot` into the page's live socket as if the server had sent it.
 * Exercises the client's own ordering and validation only — the room never sees this frame.
 */
async function injectSnapshot(page: Page, snapshot: RoomSnapshot): Promise<void> {
  await page.evaluate((room) => {
    const socket = window.__spelltypeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error('no open room socket to inject into');
    socket.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ type: 'state', room }) }),
    );
  }, snapshot);
}

/** Fires the two reconnect triggers the client listens for. */
async function fireReconnectTriggers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

interface InstrumentedRoom {
  hostContext: BrowserContext;
  hostPage: Page;
  guest: Session;
  roomId: string;
  feed: SnapshotFeed;
  capture: SocketCapture;
  selfId: string;
  close(): Promise<void>;
}

/**
 * A real two-player room whose host page carries the socket exposure: real accounts, real
 * navigation, real sockets. The guest is an ordinary seat that only idles.
 */
async function instrumentedRoom(browser: Browser, theme: string): Promise<InstrumentedRoom> {
  const hostContext = await newContext(browser);
  const hostPage = await hostContext.newPage();
  const feed = snapshotFeed(hostPage);
  const capture = captureSockets(hostPage);
  await hostPage.addInitScript(() => {
    const Original = window.WebSocket;
    const sockets: WebSocket[] = [];
    class Tracked extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        if (
          !/^\/api\/releases\/[0-9a-f]{32}\/rooms\/[0-9a-f]{24}\/ws$/.test(
            new URL(String(args[0]), location.href).pathname,
          )
        )
          return;
        sockets.push(this);
        this.addEventListener('open', () => {
          window.__spelltypeSocket = this;
        });
      }
    }
    window.WebSocket = Tracked;
    window.__spelltypeSockets = sockets;
  });
  await gotoApp(hostPage, '/');
  const username = uniqueName('cli');
  await signUp(hostPage, username);
  const guest = await signedInContext(browser, 'clig');
  const roomId = await createRoom(hostPage, { theme });
  await gotoApp(guest.page, `/?room=${roomId}`);
  await expect(guest.page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  await waitForLobbyPlayers(hostPage, [username, guest.username]);
  await setReady(guest.page, true);
  await startMatch(hostPage);
  await Promise.all([waitForCombat(hostPage), waitForCombat(guest.page)]);
  const selfId = (await apiJson<{ user: { id: string } }>(hostContext, '/api/session')).body.user
    .id;
  return {
    hostContext,
    hostPage,
    guest,
    roomId,
    feed,
    capture,
    selfId,
    close: async () => {
      await hostContext.close();
      await guest.context.close();
    },
  };
}

/** Types an accepted prefix and forces one real server rejection on the current spell. */
async function rejectCurrentSpell(page: Page, roomId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await roomSnapshot(page.context(), roomId);
    const gate = snapshot.selfInputGate;
    if (snapshot.phase !== 'playing' || snapshot.spell === null || gate === null) {
      await settle(200);
      continue;
    }
    if (snapshot.serverNow < gate.notBefore) {
      const epochBefore = gate.draftEpoch;
      const prefix = snapshot.spell.text.slice(0, 4);
      await typingInput(page).fill(prefix);
      await expect
        .poll(async () => (await roomSnapshot(page.context(), roomId)).selfInput)
        .toBe(prefix);
      await typingInput(page).fill(snapshot.spell.text);
      for (let poll = 0; poll < 100; poll += 1) {
        const after = await roomSnapshot(page.context(), roomId);
        if (after.selfInputGate && after.selfInputGate.draftEpoch > epochBefore) return;
        await settle(100);
      }
      throw new Error('premature completion was not rejected');
    }
    await completeSpell(page);
  }
  throw new Error('could not stage a rejection');
}

/* ------------------------------------------------------------------- ordering */

test('注入的过期纪元与过期光标快照不会回退已接受的新状态', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await instrumentedRoom(browser, '排序契约');
  const { hostPage, feed, capture, roomId, selfId } = room;

  // A real rejection moves the client to epoch 1 with the restored draft and the reason.
  await completeSpell(hostPage);
  await rejectCurrentSpell(hostPage, roomId);
  const real = await capturedSnapshot(feed, (view) => (view.selfInputGate?.draftEpoch ?? 0) >= 1);
  const acceptedDraft = real.selfInput;
  expect(acceptedDraft).toBe(real.spell!.text.slice(0, 4));
  expect(await inputValue(hostPage)).toBe(acceptedDraft);

  // INJECTED: the same snapshot with the epoch wound back and the reason erased. The client
  // must drop it wholesale — field, reason and stats stay at the newer accepted state.
  await injectSnapshot(hostPage, {
    ...real,
    selfInput: '',
    selfInputGate: { ...real.selfInputGate!, draftEpoch: 0, resetReason: null },
  });
  expect(await inputValue(hostPage)).toBe(acceptedDraft);
  expect((await gateIndicator(hostPage)).reason).toBe('completion_too_early');

  // INJECTED: a snapshot whose spell cursor points backwards. Same wholesale drop: the target
  // and the cursor stay at the newer state.
  await injectSnapshot(hostPage, {
    ...real,
    spell: { ...real.spell!, text: 'rewound target' },
    players: real.players.map((player) =>
      player.id === selfId ? Object.assign({}, player, { spellIndex: 0 }) : player,
    ),
  });
  expect(await spellText(hostPage)).not.toBe('rewound target');

  // The client is unharmed: a real keystroke is judged against the real target and emitted
  // under the current identity.
  const target = await spellText(hostPage);
  await typingInput(hostPage).click();
  await hostPage.keyboard.insertText(target.slice(acceptedDraft.length, acceptedDraft.length + 1));
  const inputFrames = sentMessages(capture).filter((frame) => frame.type === 'input');
  expect(
    inputFrames.some((frame) => frame.text === target.slice(0, acceptedDraft.length + 1)),
  ).toBe(true);

  await room.close();
});

test('旧对局的迟到快照不能把已前进的房间切回', async ({ browser }) => {
  test.setTimeout(600_000);
  const room = await instrumentedRoom(browser, '旧局契约');
  const { hostPage, guest, feed, roomId } = room;
  const matchA = await battleMatchId(hostPage);

  // The last REAL snapshot of match A, captured while it was live.
  const snapshotA = await capturedSnapshot(feed, (view) => view.matchId === matchA);
  expect(snapshotA.spell).not.toBeNull();

  // Settle match A quickly (the guest forfeits), then rebuild a match B in the same room with
  // both seats back: the route now lives in match B and holds match A in its exited set.
  await guest.page.getByTestId('battle-leave').click();
  await expect.poll(() => battlePhase(hostPage), { timeout: 30_000 }).toBe('finished');
  await hostPage.getByTestId('rematch').click();
  await expect(hostPage.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  await gotoApp(guest.page, `/?room=${roomId}`);
  await expect(guest.page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  await setReady(guest.page, true);
  await startMatch(hostPage);
  await Promise.all([waitForCombat(hostPage), waitForCombat(guest.page)]);
  const matchB = await battleMatchId(hostPage);
  expect(matchB).not.toBe(matchA);
  const targetB = await spellText(hostPage);

  // INJECTED: match A's real snapshot with the clock bumped, so ONLY the match-exit guard can
  // reject it. The room view must not switch back to the abandoned match.
  await injectSnapshot(hostPage, { ...snapshotA, serverNow: Date.now() });
  expect(await battleMatchId(hostPage)).toBe(matchB);
  expect(await spellText(hostPage)).toBe(targetB);

  await room.close();
});

test('新身份在组合中到达、更高纪元恢复并入延迟绑定；组合结束不外发，真实按键用新身份', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const room = await instrumentedRoom(browser, '延迟绑定契约');
  const { hostPage, feed, capture, selfId } = room;

  // Pre-type the text the merged binding will adopt: this makes the browser's own composition
  // cancel deterministic (it reverts the field to this exact value), whatever the event order.
  const initial = await capturedSnapshot(
    feed,
    (view) => view.phase === 'playing' && Boolean(view.spell),
  );
  const mergedDraft = initial.spell!.text.slice(0, 5);
  await typingInput(hostPage).click();
  await hostPage.keyboard.insertText(mergedDraft);
  await capturedSnapshot(feed, (view) => view.selfInput === mergedDraft);
  const baseline = await capturedSnapshot(feed, (view) => Boolean(view.selfInputGate));

  // An open composition over the accepted text.
  const cdp = await hostPage.context().newCDPSession(hostPage);
  await cdp.send('Input.imeSetComposition', {
    text: 'ceshi',
    selectionStart: mergedDraft.length + 5,
    selectionEnd: mergedDraft.length + 5,
  });
  await expect.poll(() => inputValue(hostPage)).toBe(`${mergedDraft}ceshi`);

  // INJECTED #1: the next spell's identity arrives mid-composition. The binding parks it as a
  // deferred start instead of touching the candidate text.
  const nextTarget = `${mergedDraft}red target`;
  await injectSnapshot(hostPage, {
    ...baseline,
    spell: { ...baseline.spell!, text: nextTarget },
    selfInput: '',
    players: baseline.players.map((player) =>
      player.id === selfId ? { ...player, spellIndex: player.spellIndex + 1 } : player,
    ),
  });
  expect(await inputValue(hostPage)).toBe(`${mergedDraft}ceshi`);

  // INJECTED #2: a higher-epoch restore for that parked identity. It must MERGE into the
  // deferred start (new draft, new epoch), still without touching the composition.
  await injectSnapshot(hostPage, {
    ...baseline,
    spell: { ...baseline.spell!, text: nextTarget },
    selfInput: mergedDraft,
    selfInputGate: {
      ...baseline.selfInputGate!,
      draftEpoch: baseline.selfInputGate!.draftEpoch + 1,
      resetReason: 'completion_too_early',
    },
    players: baseline.players.map((player) =>
      player.id === selfId ? { ...player, spellIndex: player.spellIndex + 1 } : player,
    ),
  });
  expect(await inputValue(hostPage)).toBe(`${mergedDraft}ceshi`);

  // The browser's real cancel ends the composition: the merged draft is adopted, and neither
  // the discarded composition value nor its trailing replay emits anything at all.
  const framesBefore = sentMessages(capture).filter((frame) => frame.type === 'input').length;
  await cdp.send('Input.imeSetComposition', {
    text: '',
    selectionStart: mergedDraft.length,
    selectionEnd: mergedDraft.length,
  });
  await expect.poll(() => inputValue(hostPage)).toBe(mergedDraft);
  await settle(500);
  const framesDuring = sentMessages(capture).filter((frame) => frame.type === 'input');
  expect(framesDuring.length).toBe(framesBefore);
  expect(framesDuring.some((frame) => (frame.text ?? '').includes('ceshi'))).toBe(false);

  // A real next key commits under the NEW identity and the MERGED epoch, exactly once.
  await hostPage.keyboard.insertText(nextTarget.slice(mergedDraft.length, mergedDraft.length + 1));
  const after = sentMessages(capture).filter((frame) => frame.type === 'input');
  const newIdentityFrames = after.filter(
    (frame) =>
      frame.spellIndex === selfOf(baseline, selfId).spellIndex + 1 &&
      frame.draftEpoch === baseline.selfInputGate!.draftEpoch + 1,
  );
  expect(newIdentityFrames).toHaveLength(1);
  expect(newIdentityFrames[0].text).toBe(nextTarget.slice(0, mergedDraft.length + 1));

  await room.close();
});

test('空门槛结束判定，随后同一身份的有效门槛真正重绑', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await instrumentedRoom(browser, '重绑契约');
  const { hostPage, feed, capture, selfId } = room;
  const baseline = await capturedSnapshot(feed, (view) => Boolean(view.selfInputGate));

  // INJECTED: a playing snapshot whose gate and stats are gone (the damaged-seat view). The
  // field must stop judging and stop sending entirely.
  await injectSnapshot(hostPage, { ...baseline, selfInputGate: null, selfInputStats: null });
  const framesBefore = sentMessages(capture).filter((frame) => frame.type === 'input').length;
  await typingInput(hostPage).click();
  await hostPage.keyboard.insertText('x');
  await settle(400);
  expect(sentMessages(capture).filter((frame) => frame.type === 'input')).toHaveLength(
    framesBefore,
  );

  // INJECTED: the real gated snapshot for the same identity again. The binding must truly
  // rebind: the field adopts the server draft and judging resumes under that gate.
  await injectSnapshot(hostPage, baseline);
  const target = await spellText(hostPage);
  await hostPage.keyboard.insertText(target.slice(0, 1));
  const frames = sentMessages(capture).filter((frame) => frame.type === 'input');
  expect(frames.length).toBeGreaterThan(framesBefore);
  expect(frames.at(-1)!.draftEpoch).toBe(baseline.selfInputGate!.draftEpoch);
  expect(frames.at(-1)!.spellIndex).toBe(selfOf(baseline, selfId).spellIndex);

  await room.close();
});

test('快照版本不符是终态：刷新按钮出现，在线与可见事件不重连', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await instrumentedRoom(browser, '版本契约');
  const { hostPage, feed } = room;
  const baseline = await capturedSnapshot(feed, (view) => Boolean(view.spell));

  // INJECTED: a successful state frame naming another wire protocol. The client treats it as
  // terminal update-required, closes its own connection and never reopens it.
  const socketsBefore = await hostPage.evaluate(() => window.__spelltypeSockets!.length);
  await injectSnapshot(hostPage, { ...baseline, protocolVersion: 'spelltype.v0' });
  await expect(hostPage.getByTestId('room-error')).toContainText('客户端版本已更新');
  await expect(hostPage.getByTestId('room-reload')).toBeVisible();
  for (let burst = 0; burst < 4; burst += 1) {
    await fireReconnectTriggers(hostPage);
    await settle(300);
  }
  expect(await hostPage.evaluate(() => window.__spelltypeSockets!.length)).toBe(socketsBefore);

  await room.close();
});

test('迟到的HTTP裁决不会冲击新连接：离线/上线换代后，旧的401裁决被丢弃', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await instrumentedRoom(browser, '诊断契约');
  const { hostPage } = room;

  // Hold the diagnosis's first read (the session check). Once released it answers 401 — a
  // verdict that WOULD tear the connection down as auth-expired, if it were not stale.
  let held: (() => void) | null = null;
  const releaseHeld = Promise.withResolvers<void>();
  await hostPage.context().route('**/api/session', async (route) => {
    if (held === null) {
      held = () => releaseHeld.resolve();
      await releaseHeld.promise;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: '登录状态已失效，请重新登录' }),
      });
      return;
    }
    await route.continue();
  });

  // The socket dies an ordinary death: the client starts its HTTP diagnosis and waits on the
  // held session read.
  const socketsBefore = await hostPage.evaluate(() => window.__spelltypeSockets!.length);
  await hostPage.evaluate(() => window.__spelltypeSocket!.close());
  await settle(300);
  expect(held).not.toBeNull();

  // While the stale diagnosis pends, offline/online cycles the generation: the offline detach
  // drops the dead socket and the online trigger opens a fresh, OPEN connection.
  await hostPage.evaluate(() => window.dispatchEvent(new Event('offline')));
  await hostPage.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(() => hostPage.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 30_000,
    })
    .toBe('open');
  expect(await hostPage.evaluate(() => window.__spelltypeSockets!.length)).toBe(socketsBefore + 1);

  // NOW the stale 401 verdict lands, one generation too late. It must be dropped wholesale:
  // the room stays open, no terminal notice, no auth eviction, and no third socket ever forms.
  held!();
  await settle(2000);
  expect(await hostPage.getByTestId('connection-status').getAttribute('data-state')).toBe('open');
  expect(await hostPage.getByTestId('view-room').isVisible()).toBe(true);
  expect(await hostPage.getByTestId('room-error').count()).toBe(0);
  expect(await hostPage.evaluate(() => window.__spelltypeSockets!.length)).toBe(socketsBefore + 1);

  await hostPage.context().unroute('**/api/session');
  await room.close();
});
