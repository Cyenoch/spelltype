/**
 * 客户端协议时序与数据损坏边界，通过真实的房间界面驱动。
 *
 * 页面的原生 WebSocket 在首次文档加载前被派生继承，使测试能够触达唯一的活动房间 socket。
 * 服务端在链路上真实发送的权威状态被捕获并经测试修改后，通过 `socket.dispatchEvent` 重新灌入客户端 ——
 * 这是一种注入探针，专门用于测试客户端自身的排序和校验规则（过时快照、输入法组合中途的身份变更、
 * 无门禁状态、版本不匹配）。产品代码中对此不存在任何后门钩子；以下所有注入均被显式标明。
 *
 * 本文件证明了链路级测试所无法证明的内容：当快照乱序到达或格式损坏时，输入框、门禁指示器与数据绑定
 * 完全按照协议契约要求做出反应，且在较新连接建立之后到达的过时 HTTP 诊断结论绝不能破坏新连接。
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
    /** 页面最近打开的 WebSocket，在首个文档加载前注入安装。 */
    __spelltypeSocket?: WebSocket;
    __spelltypeSockets?: WebSocket[];
  }
}

test.beforeEach(async () => {
  await fixture().reset();
});

/* ------------------------------------------------------------- 本地辅助函数 */

interface SnapshotFeed {
  latest(): RoomSnapshot | null;
}

/** 从现在开始跟踪每一个服务端消息帧，并保留最新的权威快照。 */
function snapshotFeed(page: Page): SnapshotFeed {
  let latest: RoomSnapshot | null = null;
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => {
      try {
        const parsed = JSON.parse(String(event.payload)) as { type?: string; room?: RoomSnapshot };
        if (parsed.type === 'state' && parsed.room) latest = parsed.room;
      } catch {
        /* 忽略无效成帧噪声 */
      }
    });
  });
  return { latest: () => latest };
}

/** 快照中查看者自有的玩家行。 */
function selfOf(snapshot: RoomSnapshot, selfId: string): Player {
  const player = snapshot.players.find((entry) => entry.id === selfId);
  if (!player) throw new Error(`snapshot has no player ${selfId}`);
  return player;
}

/** 等待直到 feed 捕获到满足 `when` 条件的快照。 */
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
 * 注入探针：将 `snapshot` 作为模拟服务端发送的数据重放到页面的活动 socket 中。
 * 仅用于测试客户端自身的排序与校验逻辑 —— 房间服务端绝不会看到该消息帧。
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

/** 触发客户端监听的两个重连触发器。 */
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
 * 真实的双人房间，其房主页面带有 socket 暴露能力：真实账号、真实导航、真实 socket。
 * 访客为普通的空闲席位。
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
          !/^\/api\/rooms\/[0-9a-f]{24}\/ws$/.test(new URL(String(args[0]), location.href).pathname)
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

/** 输入一段已接受的前缀，并在当前法术上强制触发一次真实的服务端拒绝。 */
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

/* ------------------------------------------------------------------- 时序校验 */

test('注入的过期纪元与过期光标快照不会回退已接受的新状态', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await instrumentedRoom(browser, '排序契约');
  const { hostPage, feed, capture, roomId, selfId } = room;

  // 真实拒绝将客户端推进到纪元 1，并恢复草稿和原因。
  await completeSpell(hostPage);
  await rejectCurrentSpell(hostPage, roomId);
  const real = await capturedSnapshot(feed, (view) => (view.selfInputGate?.draftEpoch ?? 0) >= 1);
  const acceptedDraft = real.selfInput;
  expect(acceptedDraft).toBe(real.spell!.text.slice(0, 4));
  expect(await inputValue(hostPage)).toBe(acceptedDraft);

  // 注入测试：纪元被回拨且原因被抹除的同一快照。客户端必须整包丢弃该快照 ——
  // 输入框、原因和统计数据保持在较新的已接受状态。
  await injectSnapshot(hostPage, {
    ...real,
    selfInput: '',
    selfInputGate: { ...real.selfInputGate!, draftEpoch: 0, resetReason: null },
  });
  expect(await inputValue(hostPage)).toBe(acceptedDraft);
  expect((await gateIndicator(hostPage)).reason).toBe('completion_too_early');

  // 注入测试：法术游标倒退的快照。同样整包丢弃：目标和游标保持在较新状态。
  await injectSnapshot(hostPage, {
    ...real,
    spell: { ...real.spell!, text: 'rewound target' },
    players: real.players.map((player) =>
      player.id === selfId ? Object.assign({}, player, { spellIndex: 0 }) : player,
    ),
  });
  expect(await spellText(hostPage)).not.toBe('rewound target');

  // 客户端毫发无损：真实的敲击按真实目标判定，并在当前身份下发送。
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

  // 对决 A 的最后一份真实快照，在其活跃期间捕获。
  const snapshotA = await capturedSnapshot(feed, (view) => view.matchId === matchA);
  expect(snapshotA.spell).not.toBeNull();

  // 快速结算对决 A（访客认输），然后在同一房间中由双方重新就座重开对决 B：
  // 路由当前处于对决 B，并将对决 A 记录在已退出集合中。
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

  // 注入测试：时钟被推进的对决 A 真实快照，使得仅有对决退出守卫能够拒绝它。
  // 房间视图绝不能跳回已被放弃的对决。
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

  // 预先输入合并绑定将采纳的文本：使得浏览器的输入法组合取消具有确定性
  // （将输入框还原为此精确值），无论事件顺序如何。
  const initial = await capturedSnapshot(
    feed,
    (view) => view.phase === 'playing' && Boolean(view.spell),
  );
  const mergedDraft = initial.spell!.text.slice(0, 5);
  await typingInput(hostPage).click();
  await hostPage.keyboard.insertText(mergedDraft);
  await capturedSnapshot(feed, (view) => view.selfInput === mergedDraft);
  const baseline = await capturedSnapshot(feed, (view) => Boolean(view.selfInputGate));

  // 在已接受文本之上的未决输入法组合状态。
  const cdp = await hostPage.context().newCDPSession(hostPage);
  await cdp.send('Input.imeSetComposition', {
    text: 'ceshi',
    selectionStart: mergedDraft.length + 5,
    selectionEnd: mergedDraft.length + 5,
  });
  await expect.poll(() => inputValue(hostPage)).toBe(`${mergedDraft}ceshi`);

  // 注入测试 1：下一个法术的身份在输入法组合中途到达。
  // 绑定将其挂起为延迟启动，而不干扰候选文本。
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

  // 注入测试 2：针对该挂起身份的更高纪元恢复快照。
  // 它必须合并到延迟启动中（新草稿、新纪元），依然不干扰输入法组合。
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

  // 浏览器真实的取消操作结束输入法组合：合并后的草稿被采纳，
  // 废弃的组合值及其后续重放均不会发送任何内容。
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

  // 真实的下一个按键在新身份和合并后的纪元下提交，恰好触发一次。
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

  // 注入测试：门禁与统计均丢失的 playing 状态快照（损坏席位视图）。
  // 输入框必须停止判定并彻底停止发送。
  await injectSnapshot(hostPage, { ...baseline, selfInputGate: null, selfInputStats: null });
  const framesBefore = sentMessages(capture).filter((frame) => frame.type === 'input').length;
  await typingInput(hostPage).click();
  await hostPage.keyboard.insertText('x');
  await settle(400);
  expect(sentMessages(capture).filter((frame) => frame.type === 'input')).toHaveLength(
    framesBefore,
  );

  // 注入测试：同一身份的真实带门禁快照再次到达。绑定必须切实重新绑定：
  // 输入框采纳服务端草稿并在该门禁下恢复判定。
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

  // 注入测试：声明另一传输协议的成功状态帧。客户端将其视为需要升级的终态，
  // 主动关闭连接且绝不重连。
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

  // 拦截诊断的首个读取（会话检查）。放行后返回 401 ——
  // 若非过时，该裁定本应以认证过期为由拆除连接。
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

  // socket 正常断开：客户端启动其 HTTP 诊断并在被挂起的会话读取上等待。
  const socketsBefore = await hostPage.evaluate(() => window.__spelltypeSockets!.length);
  await hostPage.evaluate(() => window.__spelltypeSocket!.close());
  await settle(300);
  expect(held).not.toBeNull();

  // 在过时诊断挂起期间，offline/online 轮转连接代际：
  // offline 丢弃已死 socket，online 触发建立全新的已连接 socket。
  await hostPage.evaluate(() => window.dispatchEvent(new Event('offline')));
  await hostPage.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(() => hostPage.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 30_000,
    })
    .toBe('open');
  expect(await hostPage.evaluate(() => window.__spelltypeSockets!.length)).toBe(socketsBefore + 1);

  // 此时，过时的 401 诊断结论终于到达（晚了一个代际）。它必须被整包丢弃：
  // 房间保持打开，无终局提示，无登出驱逐，且绝不产生第三个 socket。
  held!();
  await settle(2000);
  expect(await hostPage.getByTestId('connection-status').getAttribute('data-state')).toBe('open');
  expect(await hostPage.getByTestId('view-room').isVisible()).toBe(true);
  expect(await hostPage.getByTestId('room-error').count()).toBe(0);
  expect(await hostPage.evaluate(() => window.__spelltypeSockets!.length)).toBe(socketsBefore + 1);

  await hostPage.context().unroute('**/api/session');
  await room.close();
});
