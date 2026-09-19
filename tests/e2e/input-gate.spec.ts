/**
 * 服务端的施法时间门槛，通过真实浏览器界面做端到端观测。
 *
 * 只有浏览器才能证明的事情：强制时间下限会拒绝过早的完成，
 * 并把输入框恢复到确切的已接受草稿（空或非空、错误被保留、光标落在末尾）；
 * 一条被暂存的权威采用绝不打扰正在进行的 IME 拼写，
 * 也绝不通过随后的 input 事件复活；
 * 无论何种触发器被触发，输入过载重置的重连都绝不早于时间下限；
 * 协议不匹配状态是终态的，唯一的修复办法是刷新；
 * 已存储的策略与资格能在真实进程重启后原样存活；
 * 并且这一切在桌面与移动端视口尺寸下都可见。
 *
 * 此处的原始帧始终携带发送时从快照捕获的身份；陈旧身份是刻意原样发送的。
 * 脚本化施法测试会等过已发布的 `notBefore` ——
 * 它证明时间规则是唯一的障碍，而绝不证明打字者是人类。
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../support/test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  INITIAL_HEALTH,
  WS_PROTOCOL,
  type Profile,
  type RoomSnapshot,
} from '../../shared/protocol';
import { combatVolleys, results, rooms } from '../../server/db';
import { breakResultsSink, restoreResultsSink, resultsSinkIsBroken, testDb } from '../support/db';
import { harness } from '../support/harness';
import { apiJson, type Identity, selfIdentity } from '../support/api';
import { gotoApp, settle } from '../support/app';
import {
  backspace,
  battlePhase,
  completeSpell,
  completionDamage,
  deadline,
  gateIndicator,
  inputValue,
  insertIntoField,
  roomSnapshot,
  saveStatus,
  seatHealth,
  selfSpellIndex,
  selfSpellsCast,
  snapshotGate,
  snapshotPlayer,
  spellText,
  typeText,
  typingInput,
  waitForCombat,
  waitForInputGate,
} from '../support/combat';
import { fixture } from '../support/runtime';
import {
  createRoom,
  setReady,
  startMatch,
  twoPlayerRoom,
  waitForLobbyPlayers,
} from '../support/lobby';
import { captureCloseCodes, openRawSocket, receivedText, sentMessages } from '../support/wire';
import { newContext, signIn, signUp, signedInContext, uniqueName } from '../support/session';

/** 所有版本拒绝共用的同一句服务端文案：握手、房间 GET 与 4003 帧。 */
const UPDATE_REQUIRED = '客户端版本已更新，请刷新页面后继续。';
/** 宣布因拒绝而触发恢复的同一句服务端文案。 */
const RECOVERY_NOTICE = '输入完成早于本局施法规则，已恢复上一次接受的输入；就绪后请重新补全。';
/** 输入过载重置所用的同一句服务端文案。 */
const OVERLOAD_NOTICE = '输入消息过于密集，连接已重置；正在恢复已保存的输入。';

test.beforeEach(async () => {
  await fixture().reset();
});

/* ------------------------------------------------------------- 本地辅助函数 */

/** 通过一次真实的 input 事件在输入框光标末尾追加 `text`。 */
async function insertWholeText(page: Page, text: string): Promise<void> {
  const input = typingInput(page);
  await input.focus();
  await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.insertText(text);
}

/** 光标正好位于输入框最后一个字符之后。 */
async function expectCaretAtEnd(page: Page): Promise<void> {
  const position = await typingInput(page).evaluate<
    { start: number | null; end: number | null; length: number },
    void,
    HTMLTextAreaElement
  >((field) => ({
    start: field.selectionStart,
    end: field.selectionEnd,
    length: field.value.length,
  }));
  expect(position.start).toBe(position.length);
  expect(position.end).toBe(position.length);
}

/**
 * 布置一道当前正处于过早窗口内的新咒文。
 * 时间下限已过的咒文会被合法地完成（那次施法没问题），
 * 而这会在下一道咒文上滚出一个全新的窗口。
 */
async function atPrematureWindow(page: Page, roomId: string, maxSpells = 4): Promise<RoomSnapshot> {
  for (let attempt = 0; attempt < maxSpells; attempt += 1) {
    const snapshot = await roomSnapshot(page.context(), roomId);
    const gate = snapshot.selfInputGate;
    if (snapshot.phase !== 'playing' || snapshot.spell === null || gate === null) {
      await settle(200);
      continue;
    }
    if (snapshot.serverNow < gate.notBefore) return snapshot;
    await completeSpell(page);
  }
  throw new Error('no premature window found within the spell book');
}

/**
 * 保证在该观察者当前这道咒文上恰好发生一次拒绝：
 * 在过早窗口开启期间完成，并在服务端代际发生移动后返回。
 * 已接受草稿、统计数据以及两个席位的生命值都不受拒绝影响，
 * 这一点由各调用方自行断言。
 */
async function rejectCurrentSpell(
  page: Page,
  roomId: string,
  maxSpells = 4,
): Promise<{ epochBefore: number; snapshot: RoomSnapshot }> {
  for (let attempt = 0; attempt < maxSpells; attempt += 1) {
    const snapshot = await roomSnapshot(page.context(), roomId);
    const gate = snapshot.selfInputGate;
    if (snapshot.phase !== 'playing' || snapshot.spell === null || gate === null) {
      await settle(200);
      continue;
    }
    if (snapshot.serverNow < gate.notBefore) {
      const epochBefore = gate.draftEpoch;
      await typingInput(page).fill(snapshot.spell.text);
      for (let poll = 0; poll < 100; poll += 1) {
        const after = await roomSnapshot(page.context(), roomId);
        const afterGate = after.selfInputGate;
        if (afterGate !== null && afterGate.draftEpoch > epochBefore)
          return { epochBefore, snapshot: after };
        await settle(100);
      }
      throw new Error('premature completion was not rejected');
    }
    await completeSpell(page);
  }
  throw new Error('could not stage a premature completion');
}

/**
 * 观察模式下的对应场景：在过早窗口内完成，并证明该次施法被接受
 * （咒文计数器前进）且代际没有任何递增 —— 记录在案，而非被拦截。
 */
async function acceptPremature(
  page: Page,
  roomId: string,
  identity: Identity,
  maxSpells = 4,
): Promise<RoomSnapshot> {
  const staged = await atPrematureWindow(page, roomId, maxSpells);
  const epochBefore = staged.selfInputGate!.draftEpoch;
  const spellsBefore = snapshotPlayer(staged, identity).spellsCast;
  await insertWholeText(page, staged.spell!.text);
  for (let poll = 0; poll < 100; poll += 1) {
    const after = await roomSnapshot(page.context(), roomId);
    if (
      snapshotPlayer(after, identity).spellsCast > spellsBefore &&
      after.selfInputGate !== null &&
      after.selfInputGate.draftEpoch === epochBefore
    )
      return after;
    await settle(100);
  }
  throw new Error('premature completion was not accepted under observe mode');
}

/** 触发客户端所监听的两个重连触发器，如同一次获焦/上线突发。 */
async function fireReconnectTriggers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

interface TrackedSocket {
  received: string[];
  closed: boolean;
}

/** 从此刻起统计页面创建的每一条 WebSocket，以及每条收到的内容。 */
function trackWebsockets(page: Page): { sockets: TrackedSocket[]; count(): number } {
  const sockets: TrackedSocket[] = [];
  page.on('websocket', (socket) => {
    if (!/^\/api\/rooms\/[0-9a-f]{24}\/ws$/.test(new URL(socket.url()).pathname)) return;
    const entry: TrackedSocket = { received: [], closed: false };
    sockets.push(entry);
    socket.on('framereceived', (event) => entry.received.push(String(event.payload)));
    socket.on('close', () => {
      entry.closed = true;
    });
  });
  return { sockets, count: () => sockets.length };
}

/* ------------------------------------------------------------------ 拒绝 */

test('过早完成被拒绝：恢复已接受草稿、错误保留、光标就位，随后一次命中', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '施法门槛', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const text = await spellText(host);
  expect(await gateIndicator(host)).toMatchObject({ present: true, mode: 'enforce' });

  // 一份带有真实错误的已接受草稿：输入一个错误字符再撤回，
  // 会让整场累计错误计数停留在一，而前缀保持正确。
  await typeText(host, text.slice(0, 2));
  await insertIntoField(host, '错');
  await backspace(host, 1);
  await typeText(host, text.slice(2, 4));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(4);
  const beforeReject = await roomSnapshot(room.host.context, room.roomId);
  expect(beforeReject.selfInputStats!.errorTotal).toBe(1);
  expect(await inputValue(host)).toBe(text.slice(0, 4));

  // 在窗口内完成会被整体拒绝：没有伤害、没有事件、任何计数器都不移动。
  const rejected = await rejectCurrentSpell(host, room.roomId);
  expect(rejected.epochBefore).toBe(0);
  const afterReject = rejected.snapshot;
  expect(afterReject.selfInputGate!.resetReason).toBe('completion_too_early');
  expect(afterReject.selfInput).toBe(text.slice(0, 4));
  expect(afterReject.selfInputStats!.errorTotal).toBe(1);
  expect(snapshotPlayer(afterReject, guestIdentity).hp).toBe(INITIAL_HEALTH);
  expect(snapshotPlayer(afterReject, guestIdentity).damageDealt).toBe(0);
  expect(afterReject.events).toHaveLength(beforeReject.events.length);

  // 输入框重新变成确切的已接受草稿，光标落在其后，
  // 而打字站解释这次恢复，而不是假装已就绪。
  expect(await inputValue(host)).toBe(text.slice(0, 4));
  await expectCaretAtEnd(host);
  const indicator = await gateIndicator(host);
  expect(indicator.reason).toBe('completion_too_early');
  await expect(host.getByTestId('input-gate-reason')).toHaveText(RECOVERY_NOTICE);
  await expect(host.getByTestId('cast-feedback')).toHaveAttribute('data-state', 'idle');
  await expect(host.getByTestId('battle-tip')).toHaveText('');
  expect(await host.getByTestId('input-status').textContent()).toMatch('本局错误 1 次');

  // 该拒绝属于观察者的私有状态：对手的快照与线路上绝不携带它。
  const guestView = await roomSnapshot(room.guest.context, room.roomId);
  expect(JSON.stringify(guestView)).not.toContain('completion_too_early');
  // 客方自身的门槛归其自身所有：绝不携带房主那边递增过的代际或原因。
  expect(guestView.selfInputGate!.resetReason).toBeNull();
  expect(guestView.selfInputGate!.draftEpoch).toBe(0);
  expect(JSON.stringify(guestView.players)).not.toContain('resetReason');
  expect(JSON.stringify(guestView.players)).not.toContain('notBefore');
  expect(receivedText(room.guestSockets!)).not.toContain('completion_too_early');

  // 意图层面的向后兼容：被恢复的草稿是真实已被接受的前缀，
  // 因此等过时间下限后的合法完成会恰好生效一次。
  await waitForInputGate(host);
  await insertWholeText(host, text.slice(4));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
      {
        timeout: 30_000,
      },
    )
    .toBe(INITIAL_HEALTH - completionDamage(text));
  expect(await selfSpellsCast(host)).toBe(1);
  // 这一次施法恰好产生一个战斗事件，恢复过程不会带来任何重复。
  const settled = await roomSnapshot(room.host.context, room.roomId);
  const newEvents = settled.events.filter((event) => event.attackerId === hostIdentity.userId);
  expect(newEvents).toHaveLength(1);
  expect(newEvents[0].damage).toBe(completionDamage(text));

  await room.host.context.close();
  await room.guest.context.close();
});

test('空草稿过早完成恢复为空；等待期内无自动施法，就绪后补全一次命中', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '空草稿门槛', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const rejected = await rejectCurrentSpell(host, room.roomId);
  expect(rejected.snapshot.selfInputGate!.resetReason).toBe('completion_too_early');
  // 已接受草稿为空，因此恢复结果就是一个空输入框 —— 绝不是半完成的残留。
  expect(await inputValue(host)).toBe('');
  expect(rejected.snapshot.selfInput).toBe('');
  expect(snapshotPlayer(rejected.snapshot, guestIdentity).hp).toBe(INITIAL_HEALTH);

  // 时间下限仍在生效期间，一切都不会自行移动：不自动发包、不产生伤害、不推进游标。
  const inputsDuring = sentMessages(room.hostSockets!).filter((frame) => frame.type === 'input');
  await waitForInputGate(host);
  expect(await inputValue(host)).toBe('');
  expect(await selfSpellIndex(host)).toBe(0);
  const afterWait = await roomSnapshot(room.host.context, room.roomId);
  expect(snapshotPlayer(afterWait, guestIdentity).hp).toBe(INITIAL_HEALTH);
  expect(afterWait.events).toHaveLength(rejected.snapshot.events.length);
  const inputsAfterWait = sentMessages(room.hostSockets!).filter((frame) => frame.type === 'input');
  expect(inputsAfterWait).toHaveLength(inputsDuring.length);

  // 真正命中一次的是玩家自己完成的输入 —— 把整个目标打完。
  await insertWholeText(host, afterWait.spell!.text);
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
      {
        timeout: 30_000,
      },
    )
    .toBe(INITIAL_HEALTH - completionDamage(afterWait.spell!.text));
  expect(await selfSpellsCast(host)).toBe(1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('门槛满足后逐字、输入法确认、整段插入与选区替换同样命中', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '等价完成', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  let damaged = 0;
  let eventsSeen = 0;
  const expectGuestHp = async (text: string) => {
    damaged += completionDamage(text);
    await expect
      .poll(
        async () =>
          snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
        {
          timeout: 30_000,
        },
      )
      .toBe(INITIAL_HEALTH - damaged);
    // 该施法者恰好产生一个新的战斗事件：没有任何路径造成双重命中。
    const view = await roomSnapshot(room.host.context, room.roomId);
    const mine = view.events.filter((event) => event.attackerId === hostIdentity.userId);
    expect(mine).toHaveLength(eventsSeen + 1);
    expect(mine[mine.length - 1].damage).toBe(completionDamage(text));
    eventsSeen = mine.length;
  };

  // （1）逐击键输入整个目标。
  const first = await spellText(host);
  await waitForInputGate(host);
  await typeText(host, first);
  await expectGuestHp(first);
  expect(await selfSpellsCast(host)).toBe(1);

  // （2）经由 IME 暂存的完成：临时文本既不被判定也不被发送；被提交的那部分才会。
  const second = await spellText(host);
  await waitForInputGate(host);
  await insertIntoField(host, second.slice(0, 2));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(2);
  await host.getByTestId('typing-input').click();
  const cdp = await room.host.context.newCDPSession(host);
  await cdp.send('Input.imeSetComposition', {
    text: second.slice(2),
    selectionStart: second.length,
    selectionEnd: second.length,
  });
  await expect.poll(() => inputValue(host)).toBe(second);
  expect(await selfSpellsCast(host)).toBe(1);
  expect(
    sentMessages(room.hostSockets!)
      .filter((frame) => frame.type === 'input')
      .map((frame) => frame.text)
      .join('\n'),
  ).not.toContain(second.slice(2));
  await cdp.send('Input.insertText', { text: second.slice(2) });
  await expectGuestHp(second);
  expect(await selfSpellsCast(host)).toBe(2);

  // （3）在一次 input 事件中输入整个目标。
  const third = await spellText(host);
  await waitForInputGate(host);
  await insertWholeText(host, third);
  await expectGuestHp(third);
  expect(await selfSpellsCast(host)).toBe(3);

  // （4）一次选区替换，落下最后一个字符。
  const fourth = await spellText(host);
  await waitForInputGate(host);
  await typeText(host, `${fourth.slice(0, -1)}#`);
  await host.keyboard.press('Shift+ArrowLeft');
  expect(
    await host
      .getByTestId('typing-input')
      .evaluate<number[], void, HTMLTextAreaElement>((field) => [
        field.selectionStart,
        field.selectionEnd,
      ]),
  ).toEqual([fourth.length - 1, fourth.length]);
  await insertIntoField(host, fourth.slice(-1));
  await expectGuestHp(fourth);
  expect(await selfSpellsCast(host)).toBe(4);

  await room.host.context.close();
  await room.guest.context.close();
});

test('恢复与组合输入交错：候选不动、延迟采纳、尾随回放被丢弃，终态不复活', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '输入法恢复', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  /**
   * 输入一段已接受前缀，在其之上开启一次真实的 IME 拼写，
   * 并运行一次真实的断开/重连循环，使重连的权威采用在拼写仍开启时到达 ——
   * 它必须被暂存，绝不能被写入候选文本。返回被丢弃的拼写值，
   * 以及它必须回退到的已接受草稿。
   */
  const parkRestoreUnderComposition = async (): Promise<{
    committed: string;
    accepted: string;
    errorTotal: number;
  }> => {
    const initial = await roomSnapshot(room.host.context, room.roomId);
    const accepted = initial.selfInput;
    const errorTotal = initial.selfInputStats!.errorTotal + 1;
    await typeText(host, '错');
    await backspace(host, 1);
    expect(await inputValue(host)).toBe(accepted);
    await expect
      .poll(
        async () => (await roomSnapshot(room.host.context, room.roomId)).selfInputStats!.errorTotal,
      )
      .toBe(errorTotal);
    await host.getByTestId('typing-input').click();
    const cdp = await room.host.context.newCDPSession(host);
    const caret = accepted.length;
    await cdp.send('Input.imeSetComposition', {
      text: 'ceshi',
      selectionStart: caret + 5,
      selectionEnd: caret + 5,
    });
    await expect.poll(() => inputValue(host)).toBe(`${accepted}ceshi`);
    await room.host.context.setOffline(true);
    await expect
      .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 20_000,
      })
      .not.toBe('open');
    await room.host.context.setOffline(false);
    await expect
      .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 30_000,
      })
      .toBe('open');
    // 被暂存的采用绝不能触碰仍开启的拼写的候选文本。
    expect(await inputValue(host)).toBe(`${accepted}ceshi`);
    return { committed: `${accepted}ceshi`, accepted, errorTotal };
  };

  const framesWithCeshi = (): number =>
    sentMessages(room.hostSockets!).filter(
      (frame) => frame.type === 'input' && (frame.text ?? '').includes('ceshi'),
    ).length;

  // （a）被丢弃的拼写非空：采用在 compositionend 时胜出，
  // 随后对确切被丢弃值的重放会回退到已接受草稿，
  // 而此后真实的浏览器侧取消只是一次普通的空操作。
  const parkA = await parkRestoreUnderComposition();
  await typingInput(host).evaluate<void, string, HTMLTextAreaElement>((field, discarded) => {
    field.dispatchEvent(new Event('compositionend'));
    field.value = discarded;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, parkA.committed);
  expect(await inputValue(host)).toBe(parkA.accepted);
  expect(framesWithCeshi()).toBe(0);
  expect((await roomSnapshot(room.host.context, room.roomId)).selfInputStats!.errorTotal).toBe(
    parkA.errorTotal,
  );
  // 结束浏览器侧的拼写；回退到已接受草稿不计入任何东西。
  const cdpA = await room.host.context.newCDPSession(host);
  await cdpA.send('Input.imeSetComposition', {
    text: '',
    selectionStart: parkA.accepted.length,
    selectionEnd: parkA.accepted.length,
  });
  expect(await inputValue(host)).toBe(parkA.accepted);
  expect(framesWithCeshi()).toBe(0);
  // 一个不同的后续值 —— 目标真正的下一个字符 —— 是一次真实击键：
  // 照常判定并发送，因此恢复绝不会吞掉真实的输入。
  const nextChar = (await roomSnapshot(room.host.context, room.roomId)).spell!.text.slice(
    parkA.accepted.length,
    parkA.accepted.length + 1,
  );
  await insertIntoField(host, nextChar);
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(parkA.accepted.length + 1);

  // （b）被丢弃的拼写为空时，仍必须恢复已接受草稿，而不是把它抹掉。
  const parkB = await parkRestoreUnderComposition();
  await typingInput(host).evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.value = '';
    field.dispatchEvent(new Event('compositionend'));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await inputValue(host)).toBe(parkB.accepted);
  expect(framesWithCeshi()).toBe(0);
  const cdpB = await room.host.context.newCDPSession(host);
  await cdpB.send('Input.imeSetComposition', {
    text: '',
    selectionStart: parkB.accepted.length,
    selectionEnd: parkB.accepted.length,
  });
  expect(await inputValue(host)).toBe(parkB.accepted);

  // （c）拼写中进入终态：对局结束后，被暂存的文本绝不可能被提交。
  const terminalDraft = (await roomSnapshot(room.host.context, room.roomId)).selfInput;
  await host.getByTestId('typing-input').click();
  const cdpC = await room.host.context.newCDPSession(host);
  await cdpC.send('Input.imeSetComposition', {
    text: 'ceshi',
    selectionStart: terminalDraft.length + 5,
    selectionEnd: terminalDraft.length + 5,
  });
  await expect.poll(() => inputValue(host)).toBe(`${terminalDraft}ceshi`);
  await guest.getByTestId('battle-leave').click();
  await expect.poll(() => battlePhase(host), { timeout: 30_000 }).toBe('finished');
  await typingInput(host).evaluate((field) => field.dispatchEvent(new Event('compositionend')));
  await settle(500);
  expect(framesWithCeshi()).toBe(0);
  expect(snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).hp).toBe(
    INITIAL_HEALTH,
  );

  await room.host.context.close();
  await room.guest.context.close();
});

test('同纪元确认不回退本地编辑；连接正常时在线与可见事件不并建连接', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '确认契约', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const text = await spellText(host);
  const tracked = trackWebsockets(host);

  // 一次突发中的两次击键：当第二个字符已在本地落下后，
  // 第一个字符的确认绝不能把输入框改回一个字符。
  await typeText(host, text.slice(0, 1));
  await typeText(host, text.slice(1, 2));
  expect(await inputValue(host)).toBe(text.slice(0, 2));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(2);
  expect(await inputValue(host)).toBe(text.slice(0, 2));
  const charFrames = sentMessages(room.hostSockets!).filter(
    (frame) => frame.type === 'input' && frame.text === text.slice(0, 2),
  );
  expect(charFrames).toHaveLength(1);

  // Socket 处于打开状态：重连触发器绝不可在其旁再叠加一条连接。
  await fireReconnectTriggers(host);
  await settle(1500);
  expect(tracked.count()).toBe(0);
  await expect(host.getByTestId('connection-status')).toHaveAttribute('data-state', 'open');

  await room.host.context.close();
  await room.guest.context.close();
});

test('刷新、第二连接接管与进程重启保持草稿、纪元与资格完全一致', async ({ browser }) => {
  test.setTimeout(600_000);
  const room = await twoPlayerRoom(browser, { theme: '资格一致' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guest.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const text = await spellText(host.page);
  await typeText(host.page, text.slice(0, 4));
  await expect
    .poll(async () => (await roomSnapshot(host.context, room.roomId)).selfInput)
    .toBe(text.slice(0, 4));
  const base = await roomSnapshot(host.context, room.roomId);
  const baseGate = base.selfInputGate!;
  const baseDeadline = base.deadline;

  // 刷新：同一个已存储身份回来了，时间下限不会被重新计时。
  await host.page.reload();
  await waitForCombat(host.page);
  expect(await inputValue(host.page)).toBe(text.slice(0, 4));
  const afterReload = await roomSnapshot(host.context, room.roomId);
  expect(afterReload.selfInputGate!.draftEpoch).toBe(baseGate.draftEpoch);
  expect(afterReload.selfInputGate!.notBefore).toBe(baseGate.notBefore);
  expect(afterReload.deadline).toBe(baseDeadline);

  // 同一账号的第二个窗口接管了席位；原窗口就此永久停止，
  // 而不是为这个席位争夺。
  const trackedOriginal = trackWebsockets(host.page);
  const secondWindow = await newContext(browser);
  const secondPage = await secondWindow.newPage();
  await gotoApp(secondPage, '/');
  await signIn(secondPage, hostIdentity.username);
  await gotoApp(secondPage, `/?room=${room.roomId}`);
  await waitForCombat(secondPage);
  expect(await inputValue(secondPage)).toBe(text.slice(0, 4));
  const afterTakeover = await roomSnapshot(secondWindow, room.roomId);
  expect(afterTakeover.selfInputGate!.notBefore).toBe(baseGate.notBefore);
  await expect(host.page.getByTestId('room-error')).toContainText('接管');
  await settle(4000);
  expect(trackedOriginal.count()).toBe(0);
  // 接管已验证。Vite 仅供开发使用的重启会连终态页面一起重载，
  // 而那会合法地重新占回这个席位；这并不属于 Worker 持久性场景的一部分。
  await host.page.close();

  // 一次真实的进程重启：两个页面的 Socket 随进程一起消亡并自行重连；
  // 身份、时间下限与截止时间逐字节地按已存储的内容恢复。
  await harness().restartServer();
  await expect
    .poll(() => secondPage.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 120_000,
    })
    .toBe('open');
  await expect
    .poll(() => guest.page.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 120_000,
    })
    .toBe('open');
  await Promise.all([waitForCombat(secondPage, 120_000), waitForCombat(guest.page, 120_000)]);
  expect(await inputValue(secondPage)).toBe(text.slice(0, 4));
  const afterRestart = await roomSnapshot(secondWindow, room.roomId);
  expect(afterRestart.matchId).toBe(base.matchId);
  expect(afterRestart.selfInputGate!.draftEpoch).toBe(baseGate.draftEpoch);
  expect(afterRestart.selfInputGate!.notBefore).toBe(baseGate.notBefore);
  expect(afterRestart.deadline).toBe(baseDeadline);

  // 被保留下来的资格是真实的：其后的合法完成会正常生效。
  await waitForInputGate(secondPage);
  await insertWholeText(secondPage, text.slice(4));
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(secondWindow, room.roomId), guestIdentity).hp,
      {
        timeout: 30_000,
      },
    )
    .toBe(INITIAL_HEALTH - completionDamage(text));

  await secondWindow.close();
});

test('输入超限一次4004：在线与可见触发被地板拦住，重连保留资格而非弃赛', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '超限契约' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const closeLog = await captureCloseCodes(host);
  await host.addInitScript(() => {
    const timing = { attempts: [] as number[], closedAt: 0, triggers: [] as number[] };
    Object.assign(window, { __gateOverloadTiming: timing });
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        if (!/\/rooms\/[^/]+\/ws/.test(String(args[0]))) return;
        timing.attempts.push(Date.now());
        this.addEventListener('close', (event) => {
          if (event.code !== 4004) return;
          timing.closedAt = Date.now();
          for (const delay of [0, 300, 600])
            window.setTimeout(() => {
              timing.triggers.push(Date.now());
              window.dispatchEvent(new Event('online'));
              document.dispatchEvent(new Event('visibilitychange'));
            }, delay);
        });
      }
    };
  });
  await host.reload();
  await waitForCombat(host);
  await expect(host.getByTestId('connection-status')).toHaveAttribute('data-state', 'open');

  const beforeGate = (await roomSnapshot(room.host.context, room.roomId)).selfInputGate!;
  const tracked = trackWebsockets(host);

  // 在一个配额窗口内通过页面自身的真实 Socket 提交六十一次合法草稿：
  // 最后一次被拒绝，连接被撤销并以 4004 恰好关闭一次。
  await typingInput(host).evaluate<void, void, HTMLTextAreaElement>((field) => {
    for (let count = 1; count <= 61; count += 1) {
      field.value = 'x'.repeat(count);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect.poll(() => closeLog(), { timeout: 20_000 }).toContain(4004);
  await expect(host.getByTestId('battle-notice')).toContainText(OVERLOAD_NOTICE);

  // 从原生的关闭/构造事件计时，而不是依赖可能迟到的 Node 轮询。
  // 页面内的关闭观察器还会在时间下限内触发上线/可见性突发。

  // 过了时间下限后房间会自行恢复：相同的对局、相同的门槛、
  // 服务端所接受的草稿，且没有被判弃赛。
  await expect
    .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 15_000,
    })
    .toBe('open');
  const timing = await host.evaluate(
    () =>
      Reflect.get(window, '__gateOverloadTiming') as {
        attempts: number[];
        closedAt: number;
        triggers: number[];
      },
  );
  expect(timing.attempts).toHaveLength(2);
  expect(timing.triggers[0] - timing.closedAt).toBeLessThan(1000);
  expect(timing.attempts[1] - timing.closedAt).toBeGreaterThanOrEqual(1000);
  expect((await closeLog()).filter((code) => code === 4004)).toHaveLength(1);
  expect(tracked.count()).toBe(1);
  await expect(host.getByTestId('battle-notice')).toBeHidden({ timeout: 15_000 });
  const reconnected = await roomSnapshot(room.host.context, room.roomId);
  expect(reconnected.matchId).not.toBeNull();
  expect(reconnected.phase).toBe('playing');
  expect(reconnected.selfInputGate!.draftEpoch).toBe(beforeGate.draftEpoch);
  expect(reconnected.selfInputGate!.notBefore).toBe(beforeGate.notBefore);
  // 重连恢复的是服务端已接受的草稿，而不是一个被判弃赛的席位。
  await expect.poll(() => inputValue(host), { timeout: 15_000 }).toBe(reconnected.selfInput);
  expect(snapshotPlayer(reconnected, hostIdentity).eliminatedAt).toBeNull();
  expect(snapshotPlayer(reconnected, guestIdentity).hp).toBe(INITIAL_HEALTH);
  expect(await seatHealth(guest, guestIdentity.userId)).toEqual({
    hp: INITIAL_HEALTH,
    maxHp: INITIAL_HEALTH,
  });

  await room.host.context.close();
  await room.guest.context.close();
});

test('协议握手：无与错误子协议被拒绝，缺纪元的输入帧按旧协议关闭4003', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '握手契约' });
  const host = room.host.page;
  await waitForLobbyVisible(host);

  // 无法指明线协议的握手绝不会变成一条 Socket。
  const withoutProtocol = await openRawSocket(host, room.roomId, { protocols: [] });
  expect(withoutProtocol.opened).toBe(false);
  const wrongProtocol = await openRawSocket(host, room.roomId, { protocols: ['spelltype.v1'] });
  expect(wrongProtocol.opened).toBe(false);
  const currentProtocol = await openRawSocket(host, room.roomId, { holdMs: 300 });
  expect(currentProtocol.opened).toBe(true);

  // 一个缺少必需草稿代际的 v2 形态输入是伪装的旧客户端：
  // 先被告知刷新一次，随后以协议不匹配关闭码关闭。
  const missingEpoch = await openRawSocket(host, room.roomId, {
    holdMs: 1500,
    send: [{ type: 'input', matchId: '000000000000000000000000', spellIndex: 0, text: 'spell' }],
  });
  expect(missingEpoch.opened).toBe(true);
  expect(missingEpoch.closeCode).toBe(4003);
  expect(missingEpoch.received.join('\n')).toContain(UPDATE_REQUIRED);

  await room.host.context.close();
  await room.guest.context.close();
});

test('初始读取版本不符是终态：刷新按钮出现，网络恢复与可见事件也不重连', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '终态契约' });
  const host = room.host.page;
  const tracked = trackWebsockets(host);
  await room.host.context.route(new RegExp(`/api/rooms/${room.roomId}$`), (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'protocol:mismatch',
        error: UPDATE_REQUIRED,
        protocolVersion: WS_PROTOCOL,
      }),
    }),
  );
  await gotoApp(host, `/?room=${room.roomId}`);

  // 终态界面为页面自身提供的修复办法只有一个：刷新。
  await expect(host.getByTestId('room-error')).toContainText(UPDATE_REQUIRED);
  await expect(host.getByTestId('room-reload')).toBeVisible();
  await expect(host.getByTestId('room-error-retry')).toHaveCount(0);

  // 终态就是终态：上线、获焦与可见性触发器绝不会打开任何 Socket。
  for (let burst = 0; burst < 4; burst += 1) {
    await fireReconnectTriggers(host);
    await settle(400);
  }
  expect(tracked.count()).toBe(0);
  await room.host.context.unroute(new RegExp(`/api/rooms/${room.roomId}$`));

  await room.host.context.close();
  await room.guest.context.close();
});

test('重启后旧局策略与资格不可变；新局遵循新默认且观察模式只记录不拦截', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '策略冻结' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const enforceGate = (await roomSnapshot(room.host.context, room.roomId)).selfInputGate!;
  expect(enforceGate.mode).toBe('enforce');
  const liveDeadline = await deadline(host);

  // 实例以 observe 作为新默认值重启：进行中的对局保留其被锁定时的策略，
  // 直到那个确切存储的时间下限时刻。
  try {
    await harness().restartServer({ inputPolicyMode: 'observe' });
    await expect
      .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 90_000,
      })
      .toBe('open');
    await expect
      .poll(() => guest.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 90_000,
      })
      .toBe('open');
    await Promise.all([waitForCombat(host, 90_000), waitForCombat(guest, 90_000)]);
    const kept = await roomSnapshot(room.host.context, room.roomId);
    const matchAId = kept.matchId!;
    expect(kept.selfInputGate!.mode).toBe('enforce');
    expect(kept.selfInputGate!.policyVersion).toBe(enforceGate.policyVersion);
    expect(kept.selfInputGate!.notBefore).toBe(enforceGate.notBefore);
    expect(kept.deadline).toBe(liveDeadline);

    // 旧对局仍然强制执行：即便在 observe 配置下，过早的完成也会被拒绝。
    const staged = await atPrematureWindow(host, room.roomId);
    const rejected = await rejectCurrentSpell(host, room.roomId);
    expect(rejected.snapshot.selfInputGate!.resetReason).toBe('completion_too_early');
    expect(snapshotPlayer(rejected.snapshot, hostIdentity).spellsCast).toBe(
      snapshotPlayer(staged, hostIdentity).spellsCast,
    );

    // 结算这场被冻结的对局：离场者的行与幸存者的行都按该对局自身的策略存储，
    // 而不是按当前恰好部署的配置。
    await guest.getByTestId('battle-leave').click();
    await expect.poll(() => battlePhase(host), { timeout: 30_000 }).toBe('finished');
    await expect.poll(() => saveStatus(host), { timeout: 120_000 }).toBe('saved');

    // 新对局在新默认值下进行：observe 记录这次过早尝试并让施法落地，
    // 单场汇总为零，且没有恢复。
    const roomB = await twoPlayerRoom(browser, { theme: '观察默认' });
    const hostBIdentity = await selfIdentity(roomB.host.context);
    await startMatch(roomB.host.page);
    await Promise.all([waitForCombat(roomB.host.page), waitForCombat(roomB.guest.page)]);
    const observeGate = (await roomSnapshot(roomB.host.context, roomB.roomId)).selfInputGate!;
    expect(observeGate.mode).toBe('observe');
    expect(observeGate.draftEpoch).toBe(0);
    expect(observeGate.resetReason).toBeNull();
    const accepted = await acceptPremature(roomB.host.page, roomB.roomId, hostBIdentity);
    expect(accepted.selfInputGate!.draftEpoch).toBe(0);
    expect(accepted.selfInputGate!.resetReason).toBeNull();
    expect(snapshotPlayer(accepted, hostBIdentity).spellsCast).toBe(1);

    // 历史列按对局记录所存储的策略：enforce 那场保持为 enforce，
    // observe 那场报告其唯一一次记录在案的门槛命中、零次恢复，且不声称有人为操作。
    await roomB.guest.page.getByTestId('battle-leave').click();
    await expect.poll(() => saveStatus(roomB.host.page), { timeout: 120_000 }).toBe('saved');
    const profile = await apiJson<Profile>(roomB.host.context, '/api/profile');
    expect(profile.status).toBe(200);
    const enforceProfile = await apiJson<Profile>(room.host.context, '/api/profile');
    const enforceRow = enforceProfile.body.history.find((row) => row.match_id === matchAId);
    expect(enforceRow?.input_policy_mode).toBe('enforce');
    expect(enforceRow?.input_recoveries).toBe(1);
    const observeRow = profile.body.history.find((row) => row.match_id === accepted.matchId);
    expect(observeRow?.input_policy_mode).toBe('observe');
    expect(observeRow?.input_gate_hits).toBe(1);
    expect(observeRow?.input_recoveries).toBe(0);

    await room.host.context.close();
    await room.guest.context.close();
    await roomB.host.context.close();
    await roomB.guest.context.close();
  } finally {
    await harness().restartServer({ inputPolicyMode: 'enforce' });
  }
});

test('战绩只记一次、摘要不串局；存储只有聚合；历史只属于当前账号', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '持久摘要' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  // 一次真实的拒绝使本场对局在任何内容被存储之前就拥有非零汇总。
  const rejected = await rejectCurrentSpell(host, room.roomId);
  const matchA = rejected.snapshot.matchId!;
  expect(rejected.snapshot.selfInputGate!.draftEpoch).toBe(1);

  // 在当前这道咒文能造成击杀之前停下，并先观测每一次已提交的齐射。
  const guestHp = async () =>
    snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp;
  let lethalHp = await guestHp();
  let castCount = 0;
  while (lethalHp > completionDamage(await spellText(host))) {
    expect(castCount).toBeLessThan(40);
    const power = completionDamage(await spellText(host));
    await completeSpell(host);
    await expect.poll(guestHp).toBe(lethalHp - power);
    lethalHp -= power;
    castCount += 1;
  }
  expect(lethalHp).toBeGreaterThan(0);
  const killingIndex = await selfSpellIndex(host);
  await breakResultsSink();
  try {
    // 接受结果能在写入失败后存活，但伤害与终态不能。
    await completeSpell(host);
    expect(await selfSpellIndex(host)).toBe(killingIndex + 1);
    const [pending] = await testDb()
      .select()
      .from(combatVolleys)
      .where(eq(combatVolleys.room_id, room.roomId));
    expect(pending.casts).toHaveLength(1);
    expect(pending.casts[0]).toMatchObject({
      attackerId: hostIdentity.userId,
      spellIndex: killingIndex,
    });
    await expect
      .poll(async () => {
        const [stored] = await testDb()
          .select({ next: rooms.next_alarm_at })
          .from(rooms)
          .where(eq(rooms.id, room.roomId));
        return stored.next;
      })
      .toBeGreaterThan(pending.ends_at);
    expect(await battlePhase(host)).toBe('playing');
    expect(await guestHp()).toBe(lethalHp);
    expect((await roomSnapshot(room.host.context, room.roomId)).persistence).toBe('idle');
  } finally {
    if (await resultsSinkIsBroken()) await restoreResultsSink();
  }

  // 被接受的意图无需另一次输入即完成结算，跨重启亦然。
  // 更改默认值无法改写这场既有对局已实测的策略。
  try {
    await harness().restartServer({ inputPolicyMode: 'observe' });
    await gotoApp(host, `/?room=${room.roomId}`);
    await expect.poll(() => saveStatus(host), { timeout: 180_000 }).toBe('saved');
    const rowsA = await testDb()
      .select({
        match_id: results.match_id,
        user_id: results.user_id,
        input_policy_version: results.input_policy_version,
        input_policy_mode: results.input_policy_mode,
        input_gate_hits: results.input_gate_hits,
        input_recoveries: results.input_recoveries,
        input_min_completion_ratio: results.input_min_completion_ratio,
      })
      .from(results)
      .where(eq(results.match_id, matchA));
    expect(rowsA).toHaveLength(2);
    const hostA = rowsA.find((row) => row.user_id === hostIdentity.userId)!;
    const guestA = rowsA.find((row) => row.user_id === guestIdentity.userId)!;
    expect(hostA.input_policy_version).toBe('ascii-floor-v1');
    expect(hostA.input_policy_mode).toBe('enforce');
    expect(hostA.input_gate_hits).toBe(1);
    expect(hostA.input_recoveries).toBe(1);
    expect(hostA.input_min_completion_ratio).not.toBeNull();
    expect(hostA.input_min_completion_ratio!).toBeLessThan(1);
    expect(guestA.input_recoveries).toBe(0);
    expect(guestA.input_min_completion_ratio).toBeNull();

    // 新默认值下的第二场对局保留自己的汇总；不同对局之间不会混合。
    await roomBrematch(host, guest);
    const matchB = await roomSnapshot(room.host.context, room.roomId).then((view) => view.matchId!);
    expect(matchB).not.toBe(matchA);
    const accepted = await acceptPremature(host, room.roomId, hostIdentity);
    expect(accepted.selfInputGate!.mode).toBe('observe');
    await guest.getByTestId('battle-leave').click();
    await expect.poll(() => saveStatus(host), { timeout: 120_000 }).toBe('saved');

    const rowsAll = await testDb()
      .select({
        match_id: results.match_id,
        user_id: results.user_id,
        input_policy_mode: results.input_policy_mode,
        input_gate_hits: results.input_gate_hits,
      })
      .from(results)
      .where(inArray(results.match_id, [matchA, matchB]));
    expect(rowsAll).toHaveLength(4);
    for (const matchId of [matchA, matchB])
      for (const userId of [hostIdentity.userId, guestIdentity.userId])
        expect(
          rowsAll.filter((row) => row.match_id === matchId && row.user_id === userId),
        ).toHaveLength(1);
    const hostB = rowsAll.find(
      (row) => row.match_id === matchB && row.user_id === hostIdentity.userId,
    )!;
    expect(hostB.input_policy_mode).toBe('observe');
    expect(hostB.input_gate_hits).toBe(1);
    const hostAAgain = rowsAll.find(
      (row) => row.match_id === matchA && row.user_id === hostIdentity.userId,
    )!;
    expect(hostAAgain.input_policy_mode).toBe('enforce');

    // 持久化表只携带聚合数据：没有草稿、轨迹或原始输入列。
    const columns = await testDb()
      .select({ column_name: sql<string>`column_name` })
      .from(sql`information_schema.columns`)
      .where(sql`table_schema = 'public' AND table_name = 'results'`);
    for (const column of columns)
      expect(column.column_name.toLowerCase()).not.toMatch(
        /draft|trajectory|raw_input|keystroke|input_text/,
      );

    // 历史是私有的：每个账号恰好读到自己的行，而旁观账号读不到其中任何一行。
    const hostProfile = await apiJson<Profile>(room.host.context, '/api/profile');
    expect(hostProfile.body.history.some((row) => row.match_id === matchA)).toBe(true);
    expect(hostProfile.body.history.some((row) => row.match_id === matchB)).toBe(true);
    const guestProfile = await apiJson<Profile>(room.guest.context, '/api/profile');
    expect(guestProfile.body.history.some((row) => row.match_id === matchA)).toBe(true);
    expect(guestProfile.body.history.some((row) => row.match_id === matchB)).toBe(true);
    const bystander = await signedInContext(browser, 'bystander');
    const bystanderProfile = await apiJson<Profile>(bystander.context, '/api/profile');
    expect(
      bystanderProfile.body.history.some(
        (row) => row.match_id === matchA || row.match_id === matchB,
      ),
    ).toBe(false);

    await room.host.context.close();
    await room.guest.context.close();
    await bystander.context.close();
  } finally {
    await harness().restartServer({ inputPolicyMode: 'enforce' });
  }
});

test('按门槛等待的脚本施法正常生效', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '脚本合规' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  // 尊重已发布时间下限的脚本，施法方式与任何客户端无异：
  // 它从快照读取自身身份、等过服务端时钟，并原样发送所捕获的值。
  // 这验证的是时间规则 —— 绝不验证打字者是人类。
  let damaged = 0;
  let casts = 0;
  for (let round = 0; round < 2; round += 1) {
    let staged: RoomSnapshot | null = null;
    for (let attempt = 0; attempt < 50 && staged === null; attempt += 1) {
      const view = await roomSnapshot(room.host.context, room.roomId);
      if (view.phase === 'playing' && view.spell !== null && view.selfInputGate !== null)
        staged = view;
      else await settle(150);
    }
    if (staged === null) throw new Error('no castable state found');
    const notBefore = staged.selfInputGate!.notBefore;
    for (;;) {
      const fresh = await roomSnapshot(room.host.context, room.roomId);
      if (fresh.serverNow >= notBefore && fresh.selfInputGate!.notBefore === notBefore) break;
      await settle(120);
    }
    // 该原始帧携带的正是本脚本所捕获的身份：原样，绝不升级。
    await sendCapturedInput(host, room.roomId, {
      matchId: staged.matchId!,
      spellIndex: snapshotPlayer(staged, hostIdentity).spellIndex,
      draftEpoch: staged.selfInputGate!.draftEpoch,
      text: staged.spell!.text,
    });
    damaged += completionDamage(staged.spell!.text);
    casts += 1;
    await expect
      .poll(
        async () =>
          snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
        {
          timeout: 30_000,
        },
      )
      .toBe(INITIAL_HEALTH - damaged);
    const advanced = await roomSnapshot(room.host.context, room.roomId);
    expect(snapshotPlayer(advanced, hostIdentity).spellsCast).toBe(casts);
  }

  await room.host.context.close();
  await room.guest.context.close();
});

test('门槛与恢复的可见状态留存桌面与移动截图', async ({ browser }) => {
  test.setTimeout(420_000);
  // 房主使用测试套件的桌面视口；客方使用手机尺寸视口
  // （仅用于证明布局 —— 真实设备键盘无法被模拟）。
  const host = await signedInContext(browser, 'gate');
  const roomId = await createRoom(host.page, { theme: '可见契约' });
  const guest = await newContext(browser, { viewport: { width: 390, height: 844 } });
  const guestPage = await guest.newPage();
  await gotoApp(guestPage, '/');
  const guestName = uniqueName('gate');
  await signUp(guestPage, guestName);
  await gotoApp(guestPage, `/?room=${roomId}`);
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  await waitForLobbyPlayers(host.page, [host.username, guestName]);
  await setReady(guestPage, true);
  await startMatch(host.page);
  await waitForCombat(host.page);
  await waitForCombat(guestPage);

  const guestIdentity = await selfIdentity(guest);
  const text = await spellText(host.page);

  // 桌面端：恢复提示、被恢复的草稿、光标位置，以及仍可编辑的输入框。
  await typeText(host.page, text.slice(0, 4));
  const rejected = await rejectCurrentSpell(host.page, roomId);
  expect(await inputValue(host.page)).toBe(text.slice(0, 4));
  await expect(host.page.getByTestId('input-gate-reason')).toHaveText(RECOVERY_NOTICE);
  expect(await host.page.getByTestId('spell-text-complete').count()).toBe(0);
  await expectCaretAtEnd(host.page);
  const desktopShot = test.info().outputPath('input-gate-desktop-1440x900.png');
  await host.page.screenshot({ path: desktopShot });

  // 恢复之后输入框仍是普通编辑器：下一次击键照常被判定。
  await insertIntoField(host.page, text.slice(4, 5));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(host.context, roomId), await selfIdentity(host.context))
          .progress,
    )
    .toBe(5);

  // 移动端：同一个房间在手机视口内显示其自身的门槛。
  await expect
    .poll(async () => snapshotGate(await roomSnapshot(guest, roomId), guestIdentity))
    .not.toBeNull();
  await expect(guestPage.getByTestId('input-gate')).toBeVisible();
  await guestPage.getByTestId('input-gate').scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const box = await guestPage.getByTestId('input-gate').boundingBox();
      return box !== null && box.width > 0 && box.x >= 0 && box.x + box.width <= 390;
    })
    .toBe(true);
  const mobileShot = test.info().outputPath('input-gate-mobile-390x844.png');
  await guestPage.screenshot({ path: mobileShot });

  // 没有重复命中：被恢复的草稿完成一次，造成恰好一次伤害。
  await waitForInputGate(host.page);
  await insertWholeText(host.page, rejected.snapshot.spell!.text.slice(5));
  await expect(host.page.getByTestId('spell-text-complete')).toBeVisible();
  const expectedHp = INITIAL_HEALTH - completionDamage(rejected.snapshot.spell!.text);
  await expect
    .poll(async () => snapshotPlayer(await roomSnapshot(host.context, roomId), guestIdentity).hp, {
      timeout: 30_000,
    })
    .toBe(expectedHp);
  await settle(600);
  expect(snapshotPlayer(await roomSnapshot(host.context, roomId), guestIdentity)).toMatchObject({
    hp: expectedHp,
  });

  await host.context.close();
  await guest.close();
});

/* ------------------------------------------------------------ 测试本地衔接代码 */

/** 等待直到大厅可见（握手测试只需要一个已入座的房间，不需要战斗）。 */
async function waitForLobbyVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
}

/** 通过一条新建的原始 v2 Socket 原样发送一个已捕获的输入帧。 */
async function sendCapturedInput(
  page: Page,
  roomId: string,
  frame: { matchId: string; spellIndex: number; draftEpoch: number; text: string },
): Promise<void> {
  await openRawSocket(page, roomId, {
    holdMs: 1200,
    send: [{ type: 'input', ...frame }],
  });
}

/** 在已结算的私人房中就地再来一局（两个席位都能跨过已结算的对局存续）。 */
async function roomBrematch(host: Page, guest: Page): Promise<void> {
  await host.getByTestId('rematch').click();
  await Promise.all([
    expect(host.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 }),
    expect(guest.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 }),
  ]);
  await Promise.all([setReady(host, true), setReady(guest, true)]);
  // 进程重启后，任一条幸存的连接都可以成为房主。
  await startMatch((await host.getByTestId('lobby-start').isVisible()) ? host : guest);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
}
