/**
 * The one long release scenario, run against real native servers and the real release API.
 *
 * Two servers run SIMULTANEOUSLY: release A (role `all`, active) and, from the middle of the
 * scenario on, release B (role `game`, staged — never autoactivating). The scenario assembles
 * every shape a release must respect under A — a live match, an in-flight generation held by the
 * fixture delay, a private lobby, and a waiting player — then drives stage → check → activate
 * through the real admin API while A keeps serving. Activation must pause exactly the entrances
 * (A match/room creation, A waiting tickets) while the in-flight generation still lands, the live
 * match keeps its absolute deadline and takes real input, and a dropped player reconnects into
 * the same seat. Retirement is a barrier, not a timer: unfinished matches and results must block
 * retirement until their terminal state and result rows commit atomically.
 *
 * After activation the isolation is strict: old A pages keep their bundle, their memory and their
 * URL without reloading, but every entrance they touch is refused; a fresh B player sees the
 * retired-room notice for every A room, and two fresh B players match into one brand new room
 * while the original match's persisted results survive untouched.
 */
import { randomUUID } from 'node:crypto';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { combatVolleys, rooms } from '../../server/db';
import { test } from '../support/test';
import { gameApiBase, type RoomLocation } from '../../shared/release';
import { INITIAL_HEALTH, type MatchTicket, type RoomSnapshot } from '../../shared/protocol';
import { apiJson, gameJson, selfIdentity, testReleaseId } from '../support/api';
import { settle, gotoApp, openHome } from '../support/app';
import {
  battleMatchId,
  battlePhase,
  completeSpell,
  completionDamage,
  deadline,
  inputValue,
  roomSnapshot,
  selfSpellIndex,
  selfSpellsCast,
  snapshotPlayer,
  spellText,
  timerRemaining,
  typeText,
  waitForCombat,
  waitForMatchEnd,
  endReason,
  saveStatus,
} from '../support/combat';
import {
  breakResultsSink,
  resultRowsFor,
  resultsSinkIsBroken,
  restoreResultsSink,
  testDb,
} from '../support/db';
import { harness, TEST_RELEASE_A, TEST_RELEASE_B } from '../support/harness';
import { twoPlayerRoom } from '../support/lobby';
import { fixture, runtime, acceptedGeneration } from '../support/runtime';
import { newContext, signIn, signedInContext, type Session } from '../support/session';
import { sendRawMessages } from '../support/wire';

/** One release version's lifecycle row as the admin view reports it. */
interface ReleaseVersionView {
  releaseId: string;
  state: 'staged' | 'active' | 'retiring' | 'retired';
  artifactDigest: string | null;
  operationId: string | null;
  admissionEpoch: number;
  runtimeEpoch: number;
  retiredAt: number | null;
}

/** The admin's full view: the answering server's compiled id, the pointer and every version. */
interface ReleaseView {
  releaseId: string;
  control: { activeReleaseId: string; revision: number; updatedAt: number } | null;
  versions: ReleaseVersionView[];
}

/** What still holds a release, exactly as `probeRetirement` reports it. */
interface RetirementProbe {
  releaseId: string;
  state: string;
  admissionEpoch: number;
  activeMatches: number;
  liveReservations: number;
  waitingTickets: number;
  pendingResults: number;
  runtimeKnown: boolean;
  ready: boolean;
}

interface MarkerWindow extends Window {
  __releaseLifecycleMarker?: string;
}

async function adminView(path: string, data?: unknown): Promise<ReleaseView> {
  const response = await harness().admin<ReleaseView>(path, { data });
  expect(response.status).toBe(200);
  return response.body;
}

function versionOf(view: ReleaseView, releaseId: string): ReleaseVersionView {
  const version = view.versions.find((entry) => entry.releaseId === releaseId);
  if (!version) throw new Error(`release ${releaseId} missing from the admin view`);
  return version;
}

async function retirementProbe(): Promise<RetirementProbe> {
  const response = await harness().admin<RetirementProbe>('/retire/probe', {
    data: { releaseId: TEST_RELEASE_A },
  });
  expect(response.status).toBe(200);
  return response.body;
}

/** A game call against an explicit release's URL prefix with that same release header. */
function releaseJson<T>(
  context: BrowserContext,
  releaseId: string,
  gamePath: string,
  init?: {
    method?: string;
    data?: unknown;
    origin?: string;
    headers?: Record<string, string | undefined>;
  },
) {
  // The Origin is the release's own UI origin, exactly like that release's pages would send.
  const uiOrigin = runtime().uiUrls[releaseId];
  return apiJson<T>(context, `${gameApiBase(releaseId)}${gamePath}`, {
    ...init,
    origin: init?.origin ?? uiOrigin,
    headers: { 'x-spelltype-release': releaseId, ...init?.headers },
  });
}

/** The stable room locator: retained version plus the entry URL, read with the room's cookie. */
async function roomLocation(context: BrowserContext, roomId: string): Promise<RoomLocation> {
  const response = await apiJson<RoomLocation>(context, `/api/rooms/${roomId}/location`);
  expect(response.status).toBe(200);
  return response.body;
}

/** Polls or enqueues through the endpoint the queue page of the current release uses. */
async function matchTicket(session: Session): Promise<MatchTicket> {
  const response = await gameJson<MatchTicket>(session.context, '/match', { method: 'POST' });
  expect(response.status).toBe(200);
  return response.body;
}

/**
 * A random value living in the page's own JS heap: after activation it must still be there,
 * because the page was never reloaded — no poll, no service worker, no reconnect may refresh it.
 */
async function stampPageMarker(page: Page): Promise<string> {
  return page.evaluate(() => {
    const value = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    (window as MarkerWindow).__releaseLifecycleMarker = value;
    return value;
  });
}

async function pageMarker(page: Page): Promise<string> {
  return page.evaluate(() => (window as MarkerWindow).__releaseLifecycleMarker ?? '');
}

/** One room's durable volley row as the server persists the accepted cast intent. */
type VolleyRow = typeof combatVolleys.$inferSelect;

/** The room's one durable volley row — the accepted cast intent between cast and batch. */
async function durableVolley(roomId: string): Promise<VolleyRow | null> {
  const rows = await testDb().select().from(combatVolleys).where(eq(combatVolleys.room_id, roomId));
  return rows[0] ?? null;
}

/** The room row's persisted next wake-up — the durable clock a failed settle re-arms. */
async function nextAlarmAt(roomId: string): Promise<number | null> {
  const rows = await testDb()
    .select({ at: rooms.next_alarm_at })
    .from(rooms)
    .where(eq(rooms.id, roomId));
  return rows[0]?.at ?? null;
}

test('发布从 A 切到 B：双服务同时运行、战绩屏障、旧页不刷新、新版本严格隔离', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  await fixture().reset();
  const operator = await signedInContext(browser, 'op');

  // The harness opened with release A active; the answering primary server compiles A.
  const initial = await adminView('');
  expect(initial.control?.activeReleaseId).toBe(TEST_RELEASE_A);
  expect(initial.releaseId).toBe(TEST_RELEASE_A);
  expect(testReleaseId()).toBe(TEST_RELEASE_A);

  // The retirement barrier this scenario drives must start empty. A sibling spec that leaked an
  // active match, reservation or ticket would hold the barrier shut far longer than the drain
  // window below, and the failure would masquerade as this scenario's own rooms never settling.
  const preexisting = await retirementProbe();
  expect(
    {
      activeMatches: preexisting.activeMatches,
      liveReservations: preexisting.liveReservations,
      waitingTickets: preexisting.waitingTickets,
      pendingResults: preexisting.pendingResults,
    },
    'a sibling spec leaked server state into this worker: active matches, live reservations, ' +
      'waiting tickets and unsaved results must all be zero before the release scenario starts',
  ).toEqual({ activeMatches: 0, liveReservations: 0, waitingTickets: 0, pendingResults: 0 });

  // ---------------------------------------------------------------- live release-A surfaces
  // Three private rooms and a waiting player are assembled first, so activation finds a live
  // match, a held generation and a freezable lobby all at the same moment.
  const live = await twoPlayerRoom(browser, { theme: '发布对局' });
  const lobby = await twoPlayerRoom(browser, { theme: '发布大厅' });
  const lobbyMarker = await stampPageMarker(lobby.host.page);
  // The aged bundle's sockets are watched from assembly onward. Everything received before the
  // retirement seals is the healthy room's own traffic; the assertions after the sealing cover
  // the window that follows: no fresh attach, every socket closed, no authoritative state.
  const oldBundleSockets: { received: string[]; closed: boolean }[] = [];
  lobby.host.page.on('websocket', (socket) => {
    const entry: { received: string[]; closed: boolean } = { received: [], closed: false };
    oldBundleSockets.push(entry);
    socket.on('framereceived', (event) => entry.received.push(String(event.payload)));
    socket.on('close', () => {
      entry.closed = true;
    });
  });

  const waiter = await signedInContext(browser, 'wait');
  await openHome(waiter.page);
  await waiter.page.getByTestId('home-quick-start').click();
  await expect(waiter.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  });

  // The live match starts before the release moves: retirement must meet it mid-match.
  await live.host.page.getByTestId('lobby-start').click();
  await Promise.all([waitForCombat(live.host.page), waitForCombat(live.guest.page)]);
  const liveMatchId = await battleMatchId(live.host.page);
  const liveDeadline = await deadline(live.host.page);
  const liveGuest = await selfIdentity(live.guest.context);
  const book = acceptedGeneration(await fixture().state()).generation.texts;
  const liveSpell = book[0];
  await typeText(live.guest.page, liveSpell.slice(0, 5));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(live.host.context, live.roomId), liveGuest).progress,
      { timeout: 20_000 },
    )
    .toBe(5);
  const liveGuestHpBefore = snapshotPlayer(
    await roomSnapshot(live.host.context, live.roomId),
    liveGuest,
  ).hp;
  expect(liveGuestHpBefore).toBe(INITIAL_HEALTH);
  const liveHostMarker = await stampPageMarker(live.host.page);

  // The held generation: the fixture delays this one request 30s from its arrival, so activation
  // finds real in-flight work. Later requests are instant again; the held one stays held.
  await fixture().setDelay(30_000);
  const generating = await twoPlayerRoom(browser, { theme: '发布出题' });
  await generating.host.page.getByTestId('lobby-start').click();
  await expect(generating.host.page.getByTestId('spell-generation')).toBeVisible({
    timeout: 30_000,
  });
  expect((await roomSnapshot(generating.host.context, generating.roomId)).phase).toBe('generating');
  await fixture().setDelay(0);

  // ------------------------------------------------------- stage B, boot its runtime, check it
  const operationId = randomUUID();
  const staged = await adminView('/stage', {
    operationId,
    releaseId: TEST_RELEASE_B,
    artifactDigest: `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
  });
  expect(versionOf(staged, TEST_RELEASE_B).state).toBe('staged');
  expect(staged.control?.activeReleaseId).toBe(TEST_RELEASE_A);

  // A real second game runtime for B — role `game` never activates anything by itself.
  await harness().startReleaseServer(TEST_RELEASE_B);
  expect((await adminView('')).control?.activeReleaseId).toBe(TEST_RELEASE_A);

  // Booting changed nothing about admission: a merely staged release serves health probes but
  // cannot create anything.
  const premature = await releaseJson<{ code: string }>(
    operator.context,
    TEST_RELEASE_B,
    '/match',
    {
      method: 'POST',
    },
  );
  expect(premature.status).toBe(503);
  expect(premature.body.code).toBe('release:unavailable');

  // The check probes B's health over real HTTP and binds the answer to the operation.
  const checked = await harness().admin<{ releaseId: string; runtimeEpoch: number }>('/check', {
    data: { operationId, releaseId: TEST_RELEASE_B },
  });
  expect(checked.status).toBe(200);
  expect(checked.body.releaseId).toBe(TEST_RELEASE_B);
  expect(Number.isInteger(checked.body.runtimeEpoch)).toBe(true);

  // ------------------------------------------------------------------- activate: A → B
  await live.host.page.getByTestId('typing-input').focus();
  await expect(live.host.page.getByTestId('typing-input')).toBeFocused();
  const activation = { operationId, releaseId: TEST_RELEASE_B, expectedReleaseId: TEST_RELEASE_A };
  const activated = await harness().admin<{
    info: { activeReleaseId: string; updatedAt: number };
    previousReleaseId: string | null;
  }>('/activate', { data: activation });
  expect(activated.status).toBe(200);
  expect(activated.body.info.activeReleaseId).toBe(TEST_RELEASE_B);
  expect(activated.body.previousReleaseId).toBe(TEST_RELEASE_A);
  const activatedView = await adminView('');
  expect(versionOf(activatedView, TEST_RELEASE_A).state).toBe('retiring');
  expect(versionOf(activatedView, TEST_RELEASE_B).state).toBe('active');
  // Retrying the same activation is idempotent; a second operation is refused.
  const retried = await harness().admin<{
    info: { activeReleaseId: string };
    previousReleaseId: string | null;
  }>('/activate', { data: activation });
  expect(retried.status).toBe(200);
  expect(retried.body.info.activeReleaseId).toBe(TEST_RELEASE_B);
  const secondOp = await harness().admin('/activate', {
    data: { ...activation, operationId: randomUUID() },
  });
  expect(secondOp.status).toBe(409);

  // A's entrances are closed for new participants — with the stale id, with an empty value and
  // with the header omitted entirely — while the response honestly reports the active pointer.
  for (const headers of [
    { 'x-spelltype-release': TEST_RELEASE_A },
    { 'x-spelltype-release': '' },
    { 'x-spelltype-release': undefined },
  ]) {
    const stale = await releaseJson<{ code: string; activeReleaseId: string | null }>(
      operator.context,
      TEST_RELEASE_A,
      '/match',
      { method: 'POST', headers },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('release:update_required');
    expect(stale.body.activeReleaseId).toBe(TEST_RELEASE_B);
  }

  // The queue settles into its outdated terminal state and shows the server's own message.
  await expect(waiter.page.getByTestId('queue-state')).toContainText('版本已更新', {
    timeout: 30_000,
  });
  await expect(waiter.page.getByTestId('release-banner')).toContainText('新版本已上线', {
    timeout: 30_000,
  });
  // Publishing new metadata must not suspend the live room and lose its editor focus.
  await expect(live.host.page.getByTestId('release-banner')).toContainText('新版本已上线');
  await expect(live.host.page.getByTestId('typing-input')).toBeFocused();

  // The frozen lobby: both entrances go dark while the room keeps its state, and the snapshot
  // itself carries the freeze (the room runtime watches its row for the externally set flag).
  await expect
    .poll(async () => (await roomSnapshot(lobby.host.context, lobby.roomId)).draining, {
      timeout: 30_000,
    })
    .toBe(true);
  expect((await roomSnapshot(lobby.host.context, lobby.roomId)).releaseId).toBe(TEST_RELEASE_A);
  await expect(lobby.host.page.getByTestId('lobby-start')).toBeDisabled({ timeout: 30_000 });
  await expect(lobby.guest.page.getByTestId('lobby-ready')).toBeDisabled({ timeout: 30_000 });
  // A raw frame over the still-open socket is refused by the room itself, not just the button.
  await sendRawMessages(lobby.host.page, lobby.roomId, [
    { type: 'ready', ready: true },
    { type: 'start' },
  ]);
  await settle(1000);
  await expect(lobby.host.page.getByTestId('view-room')).toHaveAttribute('data-phase', 'lobby');
  await expect(lobby.host.page.getByTestId('battle-panel')).toBeHidden();

  // The held generation completes and its match still reaches combat — activation never
  // interrupts a generation that already claimed its task.
  await expect(generating.host.page.getByTestId('battle-panel')).toHaveAttribute(
    'data-phase',
    'playing',
    { timeout: 90_000 },
  );
  await waitForCombat(generating.guest.page);

  // The live match is untouched: same absolute deadline, real clock, real input, same heap.
  expect(await deadline(live.host.page)).toBe(liveDeadline);
  const remainingBefore = await timerRemaining(live.host.page);
  await settle(2200);
  expect(await timerRemaining(live.host.page)).toBeLessThan(remainingBefore - 1000);
  expect(await pageMarker(live.host.page)).toBe(liveHostMarker);
  await completeSpell(live.host.page);
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(live.host.context, live.roomId), liveGuest).hp,
      { timeout: 30_000 },
    )
    .toBe(liveGuestHpBefore - completionDamage(liveSpell));
  await expect
    .poll(async () => (await roomSnapshot(live.host.context, live.roomId)).draining, {
      timeout: 30_000,
    })
    .toBe(true);
  expect((await roomSnapshot(live.host.context, live.roomId)).releaseId).toBe(TEST_RELEASE_A);

  // A dropped player reconnects into the same seat mid-release: the active pointer must not
  // reject a reconnect just because the room's release is retiring.
  await live.guest.context.close();
  const reconnected = await newContext(browser);
  const reconnectedPage = await reconnected.newPage();
  await gotoApp(reconnectedPage, '/');
  await signIn(reconnectedPage, liveGuest.username);
  await gotoApp(reconnectedPage, `/?room=${live.roomId}`);
  await waitForCombat(reconnectedPage, 60_000);
  expect(await battleMatchId(reconnectedPage)).toBe(liveMatchId);
  expect(await deadline(reconnectedPage)).toBe(liveDeadline);
  expect(await inputValue(reconnectedPage)).toBe(liveSpell.slice(0, 5));

  // ------------------------------------------------- unsettled results hold the retirement shut
  // Whittle the live match down with committed volleys until the guest stands at the exact edge
  // of death: every cast's power is read from the spell the host is actually on, each volley is
  // observed on the guest's authoritative HP before the next cast, and the loop stops the moment
  // the NEXT accepted cast is guaranteed lethal (0 < hp ≤ the open spell's power).
  const liveGuestHp = async () =>
    snapshotPlayer(await roomSnapshot(live.host.context, live.roomId), liveGuest).hp;
  const castsBefore = await selfSpellsCast(live.host.page);
  let hpBefore = await liveGuestHp();
  let whittled = 0;
  let lethalPower = 0;
  for (;;) {
    lethalPower = completionDamage(await spellText(live.host.page));
    if (hpBefore <= lethalPower) break;
    expect(whittled).toBeLessThan(40);
    await completeSpell(live.host.page);
    whittled += 1;
    const expected = hpBefore - lethalPower;
    await expect.poll(liveGuestHp, { timeout: 20_000 }).toBe(expected);
    hpBefore = expected;
  }
  expect(hpBefore).toBeGreaterThan(0);
  expect(lethalPower).toBeGreaterThan(0);
  expect(hpBefore).toBeLessThanOrEqual(lethalPower);

  // Break the sink: the terminal transition and the result rows commit together, so a settlement
  // attempt that cannot write its rows rolls back whole.
  await breakResultsSink();
  try {
    // Exactly one eligible lethal input: the completion waits out the spell's own input gate, so
    // the server accepts it. Acceptance shows on the cursor and cast count ahead of any damage —
    // the killing volley's settlement then fails whole, and nothing about it lands.
    const killingIndex = await selfSpellIndex(live.host.page);
    await completeSpell(live.host.page);
    expect(await selfSpellsCast(live.host.page)).toBe(castsBefore + whittled + 1);
    expect(await selfSpellIndex(live.host.page)).toBe(killingIndex + 1);
    expect(await battlePhase(live.host.page)).toBe('playing');

    // The accepted intent is durable and names exactly this killing cast; the durable wake-up
    // moves past the batch boundary only once a failed settle re-armed the retry clock, and HP,
    // phase and the room's own persistence verdict show that nothing of the volley committed.
    await expect.poll(async () => durableVolley(live.roomId), { timeout: 20_000 }).not.toBeNull();
    const volley = (await durableVolley(live.roomId))!;
    expect(volley.match_id).toBe(liveMatchId);
    expect(volley.casts).toHaveLength(1);
    expect(volley.casts[0].attackerId).toBe((await selfIdentity(live.host.context)).userId);
    expect(volley.casts[0].spellIndex).toBe(killingIndex);
    expect(volley.casts[0].power).toBe(lethalPower);
    await expect
      .poll(() => nextAlarmAt(live.roomId), { timeout: 20_000 })
      .toBeGreaterThan(volley.ends_at);
    expect(await liveGuestHp()).toBe(hpBefore);
    expect((await durableVolley(live.roomId))!.casts).toEqual(volley.casts);
    expect((await roomSnapshot(live.host.context, live.roomId)).persistence).toBe('idle');

    // The probe sees two live A matches — the held generation's match and this one — and
    // retirement stays sealed.
    const blocked = await retirementProbe();
    expect(blocked.activeMatches).toBeGreaterThanOrEqual(2);
    expect(blocked.ready).toBe(false);
    const refusedComplete = await harness().admin('/retire/complete', {
      data: { releaseId: TEST_RELEASE_A, admissionEpoch: blocked.admissionEpoch },
    });
    expect(refusedComplete.status).toBe(409);
  } finally {
    // The injected fault must never outlive this test, wherever it failed above.
    if (await resultsSinkIsBroken()) await restoreResultsSink();
  }
  expect(await resultsSinkIsBroken()).toBe(false);

  // With the sink healed the room's own retry lands the durable killing volley — no further
  // input, no resubmission — and the terminal phase and every row commit together. Nobody marks
  // a settled match as unsynced afterwards, and no second killing cast was ever accepted.
  await waitForMatchEnd(live.host.page);
  expect(await endReason(live.host.page)).toBe('elimination');
  await expect.poll(() => saveStatus(live.host.page), { timeout: 120_000 }).toBe('saved');
  expect(await selfSpellsCast(live.host.page)).toBe(castsBefore + whittled + 1);
  let settledSpells = 0;
  while ((await battlePhase(generating.host.page)) === 'playing' && settledSpells < 40) {
    await completeSpell(generating.host.page);
    settledSpells += 1;
  }
  await waitForMatchEnd(generating.host.page);
  await expect.poll(() => saveStatus(generating.host.page), { timeout: 120_000 }).toBe('saved');

  // A raw rematch frame over the finished match is refused by the frozen room: the release can
  // never silently turn a settled match into a new one.
  await sendRawMessages(live.host.page, live.roomId, [{ type: 'rematch' }]);
  await settle(1000);
  await expect(live.host.page.getByTestId('battle-panel')).toHaveAttribute(
    'data-phase',
    'finished',
  );

  // ------------------------------------------------------------- drain to ready, then retire
  const probeDeadline = Date.now() + 120_000;
  let probe = await retirementProbe();
  while (Date.now() < probeDeadline && !probe.ready) {
    await settle(2000);
    probe = await retirementProbe();
  }
  expect(probe.ready).toBe(true);
  expect(probe.activeMatches).toBe(0);
  expect(probe.pendingResults).toBe(0);
  expect(probe.waitingTickets).toBe(0);

  // The evidence is bound to the admission epoch: a stale epoch can never seal.
  const staleEpoch = await harness().admin('/retire/complete', {
    data: { releaseId: TEST_RELEASE_A, admissionEpoch: probe.admissionEpoch + 1 },
  });
  expect(staleEpoch.status).toBe(409);
  const servedAtRetire = oldBundleSockets.map((entry) => entry.received.length);
  const socketsAtRetire = oldBundleSockets.length;
  const retired = await adminView('/retire/complete', {
    releaseId: TEST_RELEASE_A,
    admissionEpoch: probe.admissionEpoch,
  });
  expect(versionOf(retired, TEST_RELEASE_A).state).toBe('retired');

  // Old pages learn the pointer moved but never refresh themselves: banner updates, heap and URL
  // stay exactly as they were.
  await expect(lobby.host.page.getByTestId('release-banner')).toContainText('新版本已上线', {
    timeout: 45_000,
  });
  expect(await pageMarker(lobby.host.page)).toBe(lobbyMarker);
  expect(new URL(lobby.host.page.url()).pathname).toBe('/');
  expect(await pageMarker(live.host.page)).toBe(liveHostMarker);

  // A retired room is gone for everyone: the stable locator reports the retirement, the game API
  // refuses it from the new release, and authenticated pages of either build see the notice
  // instead of attaching to the retired room or entering a reconnect loop.
  await harness().useRelease(TEST_RELEASE_B);
  const staleLocation = await roomLocation(operator.context, lobby.roomId);
  expect(staleLocation.releaseId).toBe(TEST_RELEASE_A);
  expect(staleLocation.state).toBe('retired');
  expect(staleLocation.entryUrl).toBe(`/?room=${lobby.roomId}`);
  const newbie = await signedInContext(browser, 'newb');
  await gotoApp(newbie.page, `/?room=${lobby.roomId}`);
  await expect(newbie.page.getByTestId('room-error')).toBeVisible({ timeout: 30_000 });
  await settle(3000);
  await expect(newbie.page.getByTestId('room-error')).toBeVisible();
  await expect(newbie.page.getByTestId('lobby-panel')).toBeHidden();
  const retiredSnapshot = await gameJson<{ code: string }>(
    newbie.context,
    `/rooms/${lobby.roomId}`,
  );
  expect(retiredSnapshot.status).toBe(409);
  expect(retiredSnapshot.body.code).toBe('release:room_retired');
  const staleInvite = await newContext(browser);
  await staleInvite.addCookies(await lobby.host.context.cookies());
  const staleInvitePage = await staleInvite.newPage();
  await gotoApp(staleInvitePage, `/?room=${lobby.roomId}`);
  await expect(staleInvitePage.getByTestId('room-error')).toBeVisible({ timeout: 30_000 });
  await expect(staleInvitePage.getByTestId('lobby-panel')).toBeHidden();
  expect(new URL(staleInvitePage.url()).search).toBe(`?room=${lobby.roomId}`);
  await staleInvite.close();

  // A confirmed retired room is a dead end the player can still walk away from: the notice's
  // explicit Home action is the only exit — an acknowledged local departure, never a reload and
  // never a requeue. The retirement behind the click is already proven above by the stable
  // locator (`staleLocation.state === 'retired'`) and the game API's own refusal. The aged A
  // page reaches the same notice through its own socket's terminal diagnosis, so the same click
  // must work there without disturbing its heap or its bundle.
  await expect(lobby.host.page.getByTestId('room-error')).toBeVisible();
  const newbieMarker = await stampPageMarker(newbie.page);
  await newbie.page.getByTestId('room-error-home').click();
  await expect(newbie.page.getByTestId('room-error')).toBeHidden();
  expect(new URL(newbie.page.url()).search).toBe('');
  expect(new URL(newbie.page.url()).pathname).toBe('/');
  expect(await pageMarker(newbie.page)).toBe(newbieMarker);
  await expect(newbie.page.getByTestId('home-quick-start')).toBeVisible();
  await lobby.host.page.getByTestId('room-error-home').click();
  await expect(lobby.host.page.getByTestId('room-error')).toBeHidden();
  expect(new URL(lobby.host.page.url()).search).toBe('');
  expect(new URL(lobby.host.page.url()).pathname).toBe('/');
  expect(await pageMarker(lobby.host.page)).toBe(lobbyMarker);

  // Use a fresh A document: an earlier replacement must not bypass the leave request.
  const stoppedPage = await lobby.host.context.newPage();
  await stoppedPage.goto(new URL(`/?room=${lobby.roomId}`, lobby.host.page.url()).href);
  await expect(stoppedPage.getByTestId('room-error')).toBeVisible();
  const stoppedMarker = await stampPageMarker(stoppedPage);
  let stoppedOwnerRequests = 0;
  await stoppedPage.route(
    `**/api/releases/${TEST_RELEASE_A}/rooms/${lobby.roomId}/leave`,
    (route) => {
      stoppedOwnerRequests += 1;
      return route.fulfill({ status: 502, body: 'Retired game process is stopped' });
    },
  );
  await stoppedPage.getByTestId('room-error-home').click();
  await expect.poll(() => stoppedOwnerRequests).toBe(1);
  await expect(stoppedPage.getByTestId('view-home')).toBeVisible();
  expect(new URL(stoppedPage.url()).search).toBe('');
  expect(await pageMarker(stoppedPage)).toBe(stoppedMarker);
  await stoppedPage.close();

  // The aged bundle never re-enters and is never fed authority again: no new socket may open
  // after the release died, every observed socket must be closed, and beyond the retirement
  // instant not one authoritative state frame reaches the old page (the old-build-vs-new-server
  // terminal contract, proven against a real retired release rather than a saved artifact).
  await settle(3000);
  expect(oldBundleSockets.length).toBeLessThanOrEqual(socketsAtRetire);
  for (const entry of oldBundleSockets) expect(entry.closed).toBe(true);
  oldBundleSockets.forEach((entry, index) => {
    const tail = entry.received.slice(servedAtRetire[index] ?? 0).join('\n');
    expect(tail).not.toContain('"type":"state"');
  });

  // Two fresh B players match into one brand new room and really fight in it.
  const first = await signedInContext(browser, 'nb1');
  const second = await signedInContext(browser, 'nb2');
  await matchTicket(second);
  const firstTicket = await matchTicket(first);
  const secondTicket = await matchTicket(second);
  expect(firstTicket.state).toBe('matched');
  expect(secondTicket.state).toBe('matched');
  const newRoomId = firstTicket.roomId!;
  expect(secondTicket.roomId).toBe(newRoomId);
  expect(newRoomId).not.toBe(live.roomId);
  expect(newRoomId).not.toBe(generating.roomId);
  expect(newRoomId).not.toBe(lobby.roomId);
  for (const session of [first, second]) await gotoApp(session.page, `/?room=${newRoomId}`);
  for (const session of [first, second]) await waitForCombat(session.page, 60_000);
  const fresh = await gameJson<RoomSnapshot>(first.context, `/rooms/${newRoomId}`);
  expect(fresh.status).toBe(200);
  expect(fresh.body.id).toBe(newRoomId);
  expect(fresh.body.releaseId).toBe(TEST_RELEASE_B);
  expect(fresh.body.draining).toBe(false);
  const secondIdentity = await selfIdentity(second.context);
  await completeSpell(first.page);
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(first.context, newRoomId), secondIdentity).hp,
      { timeout: 30_000 },
    )
    .toBeLessThan(INITIAL_HEALTH);

  // The original match's persisted results survived the whole release untouched — the old match
  // belongs to exactly its two A players, never to anyone who arrived under B.
  const savedRows = await resultRowsFor(liveMatchId);
  expect(savedRows).toHaveLength(2);
  expect(new Set(savedRows.map((row) => row.user_id))).toEqual(
    new Set([liveGuest.userId, (await selfIdentity(live.host.context)).userId]),
  );

  await operator.context.close();
  await reconnected.close();
  await waiter.context.close();
  await newbie.context.close();
  await generating.host.context.close();
  await generating.guest.context.close();
  await lobby.host.context.close();
  await lobby.guest.context.close();
  await first.context.close();
  await second.context.close();
});
