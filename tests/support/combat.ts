/**
 * 战斗辅助：实时竞技场 DOM 的读取器，以及通过真实输入框打出真实咒文的驱动器。
 * 这里的一切都读取 DuelInterface 所记录的契约（data-testid 钩子与 data-* 属性），
 * 绝不依赖偶然文案或私有实现。
 *
 * 整场对局的驱动会在一次 input 事件中通过真实输入框提交剩余文本；
 * typing.spec.ts 保留逐击键、改正、粘贴与 IME 的覆盖。两条路径
 * 都仍然要求服务端确认、原子伤害与游标推进。
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  DAMAGE_PER_CHARACTER,
  type Player,
  type RoomSnapshot,
  type SelfInputGate,
} from '../../shared/protocol';
import { gameJson, selfIdentity, type Identity } from './api';
import { settle } from './app';

/** 单次服务端往返允许的最长时间，超过则测试应视为失败。 */
const ACK_TIMEOUT = 30_000;

function battlePanel(page: Page): Locator {
  return page.getByTestId('battle-panel');
}

export async function battlePhase(page: Page): Promise<string> {
  return (await battlePanel(page).getAttribute('data-phase')) ?? '';
}

export async function battleMatchId(page: Page): Promise<string> {
  return (await battlePanel(page).getAttribute('data-match-id')) ?? '';
}

/** 观察者私有的、单调递增、从零开始的咒文游标。 */
export async function selfSpellIndex(page: Page): Promise<number> {
  return Number(await battlePanel(page).getAttribute('data-spell-index'));
}

export async function selfSpellsCast(page: Page): Promise<number> {
  return Number(await battlePanel(page).getAttribute('data-spells-cast'));
}

/** 对局进行中为空；结束时为 `elimination`、`timeout` 等。 */
export async function endReason(page: Page): Promise<string> {
  return (await battlePanel(page).getAttribute('data-end-reason')) ?? '';
}

export function typingInput(page: Page): Locator {
  return page.getByTestId('typing-input');
}

export async function inputValue(page: Page): Promise<string> {
  return typingInput(page).inputValue();
}

export async function castState(page: Page): Promise<string> {
  return (await page.getByTestId('cast-feedback').getAttribute('data-state')) ?? '';
}

/**
 * 应用用 `String(boolean)` 写入 `data-*` 标记，因此标记要么是 "true"/"false"，
 * 要么是钩子契约所记录的 "1"/"0" 形式。对读取者而言两者含义相同。
 */
function flagValue(value: string | null): boolean {
  return value === '1' || value === 'true';
}

/** 一张席位卡片，以账号 id 定位（DOM 以 `data-user` 作为席位键）。 */
function arenaSeat(page: Page, userId: string): Locator {
  return page.locator(`[data-testid="arena-seat"][data-user="${userId}"]`);
}

/** 按 DOM 顺序排列的席位账号 id（视觉列顺序：观察者在最左，其余席位按升序排列）。 */
export async function seatOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId('arena-seat')
    .evaluateAll((seats) => seats.map((seat) => seat.getAttribute('data-user') ?? ''));
}

export interface SeatHealth {
  hp: number;
  maxHp: number;
}

export async function seatHealth(page: Page, userId: string): Promise<SeatHealth> {
  const hp = arenaSeat(page, userId).getByTestId('arena-hp');
  return {
    hp: Number(await hp.getAttribute('aria-valuenow')),
    maxHp: Number(await hp.getAttribute('aria-valuemax')),
  };
}

export async function seatIsOut(page: Page, userId: string): Promise<boolean> {
  return flagValue(await arenaSeat(page, userId).getAttribute('data-eliminated'));
}

/** 另一名玩家当前咒文已被接受的前缀，从其席位卡片读取。 */
export async function opponentProgress(page: Page, userId: string): Promise<number> {
  return Number(
    await arenaSeat(page, userId).getByTestId('player-progress').getAttribute('aria-valuenow'),
  );
}

/** 读取无障碍目标文本，而不是那些显示玩家实际错误的字形。 */
export async function spellText(page: Page): Promise<string> {
  const plain = (await page.getByTestId('spell-text-plain').textContent()) ?? '';
  return plain.replace(/^[^：]*：/, '').trim();
}

/** 对局进行中返回整场剩余毫秒数，开局阶段返回倒计时剩余时间。 */
export async function timerRemaining(page: Page): Promise<number> {
  return Number(await page.getByTestId('match-timer').getAttribute('data-remaining-ms'));
}

/** 房间唯一的截止时间：先是倒计时结束，随后是战斗结束。它绝不延长。 */
export async function deadline(page: Page): Promise<number> {
  return Number(await battlePanel(page).getAttribute('data-deadline'));
}
export interface ResultBanner {
  outcome: string;
  endReason: string;
}

export async function resultBanner(page: Page): Promise<ResultBanner> {
  const banner = page.getByTestId('result-banner');
  return {
    outcome: (await banner.getAttribute('data-outcome')) ?? '',
    endReason: (await banner.getAttribute('data-end-reason')) ?? '',
  };
}

export async function saveStatus(page: Page): Promise<string> {
  return (await page.getByTestId('save-status').getAttribute('data-state')) ?? '';
}

export interface FinalRow {
  /** 账号 id，以及该行所携带的任意标签文本。 */
  user: string;
  text: string;
  rank: number;
  hp: number;
  maxHp: number;
  damage: number;
  spells: number;
  cpm: number;
  accuracy: string;
  eliminated: boolean;
}

/** 面板自身单元格中读出的全部已结束对局行。 */
export async function finalRows(page: Page, timeout = ACK_TIMEOUT): Promise<FinalRow[]> {
  await expect(page.getByTestId('final-panel')).toBeVisible({ timeout });
  const rows = await page.getByTestId('final-row').all();
  return Promise.all(
    rows.map(async (row) => {
      const hpCell = row.getByTestId('final-row-hp');
      const numberIn = async (id: string) =>
        Number(((await row.getByTestId(id).textContent()) ?? '').replace(/[^\d.-]/g, ''));
      return {
        user: (await row.getAttribute('data-user')) ?? '',
        text: ((await row.textContent()) ?? '').trim(),
        rank: Number(await row.getAttribute('data-rank')),
        hp: Number(await hpCell.getAttribute('data-hp')),
        maxHp: Number(await hpCell.getAttribute('data-max-hp')),
        damage: await numberIn('final-row-damage'),
        spells: await numberIn('final-row-spells'),
        cpm: await numberIn('final-row-cpm'),
        accuracy: ((await row.getByTestId('final-row-accuracy').textContent()) ?? '').trim(),
        eliminated: flagValue(await row.getAttribute('data-eliminated')),
      };
    }),
  );
}

/** 房间对某位参与者的权威视图。 */
export function snapshotPlayer(snapshot: RoomSnapshot, identity: Identity): Player {
  const player = snapshot.players.find((entry) => entry.id === identity.userId);
  if (!player) throw new Error(`room ${snapshot.id} has no player ${identity.username}`);
  return player;
}

/**
 * 房间的权威快照，按每个 v2 客户端都必须采用的方式读取：
 * 精确的房间 GET 受版本门控，因此该读取会携带当前的协议请求头。
 * 缺失或错误的请求头会得到服务端的 409，而绝不是一份快照。
 */
export async function roomSnapshot(context: BrowserContext, roomId: string): Promise<RoomSnapshot> {
  const response = await gameJson<RoomSnapshot>(context, `/rooms/${roomId}`);
  expect(response.status).toBe(200);
  return response.body;
}

/** 快照中观察者自身的输入门槛（在有效的 playing 状态之外为 null）。 */
export function snapshotGate(snapshot: RoomSnapshot, identity: Identity): SelfInputGate | null {
  snapshotPlayer(snapshot, identity);
  return snapshot.selfInputGate ?? null;
}

/* ------------------------------------------------------------- 输入门槛 */

export interface GateIndicator {
  present: boolean;
  mode: string;
  /** 门槛仍将就绪状态推迟的毫秒数；就绪或不存在时为 null。 */
  remainingMs: number | null;
  reason: string;
  text: string;
}

/** 读取打字站的输入门槛指示器（`data-testid="input-gate"`）。 */
export async function gateIndicator(page: Page): Promise<GateIndicator> {
  const gate = page.getByTestId('input-gate');
  if ((await gate.count()) === 0)
    return { present: false, mode: '', remainingMs: null, reason: '', text: '' };
  const remaining = await gate.getAttribute('data-ready-remaining-ms');
  return {
    present: true,
    mode: (await gate.getAttribute('data-mode')) ?? '',
    remainingMs: remaining === null || remaining === '' ? null : Number(remaining),
    reason: (await gate.getAttribute('data-reason')) ?? '',
    text: ((await gate.textContent()) ?? '').trim(),
  };
}

/**
 * 等待直到本页面的观察者可以合法地完成其当前咒文：
 * 房间处于 playing、观察者自身的门槛已发布，且服务端时钟已到达 `notBefore`。
 *
 * 首次观测所捕获的身份 —— 对局、咒文索引、草稿代际 —— 定义了在等待什么。
 * 若后续快照的对局不同、观察者已倒下或其状态已损坏，则以诊断信息快速失败，
 * 而不是在一个永远不可能就绪的条目上超时。
 * 同一场对局内单纯的索引/代际推进只会重新捕获当前身份。
 */
export async function waitForInputGate(page: Page, timeout = 60_000): Promise<void> {
  const roomId = new URL(page.url()).searchParams.get('room');
  if (!roomId) throw new Error('waitForInputGate: the page is not in a room');
  const identity = await selfIdentity(page.context());
  const deadlineAt = Date.now() + timeout;
  let captured: { matchId: string; spellIndex: number; draftEpoch: number } | null = null;
  let last = '';
  for (;;) {
    if (Date.now() > deadlineAt)
      throw new Error(
        `waitForInputGate: not ready within ${timeout}ms (room ${roomId}, ${last || 'no snapshot yet'})`,
      );
    const snapshot = await roomSnapshot(page.context(), roomId);
    const self = snapshotPlayer(snapshot, identity);
    last = `phase=${snapshot.phase} match=${snapshot.matchId} index=${self.spellIndex} epoch=${snapshot.selfInputGate?.draftEpoch} notBefore=${snapshot.selfInputGate?.notBefore}`;
    if (snapshot.phase === 'finished' || snapshot.matchId === null)
      throw new Error(`waitForInputGate: the match settled before the gate opened (${last})`);
    if (snapshot.phase !== 'playing')
      throw new Error(`waitForInputGate: expected playing, saw ${snapshot.phase} (${last})`);
    if (self.eliminatedAt !== null)
      throw new Error(`waitForInputGate: this viewer is eliminated (${last})`);
    const gate = snapshot.selfInputGate;
    if (gate === null)
      throw new Error(
        `waitForInputGate: playing without a published gate is broken state (${last})`,
      );
    if (
      captured === null ||
      snapshot.matchId !== captured.matchId ||
      self.spellIndex !== captured.spellIndex
    ) {
      if (captured !== null && snapshot.matchId !== captured.matchId)
        throw new Error(
          `waitForInputGate: the match changed while waiting (${captured.matchId} → ${snapshot.matchId})`,
        );
      captured = {
        matchId: snapshot.matchId,
        spellIndex: self.spellIndex,
        draftEpoch: gate.draftEpoch,
      };
    }
    if (snapshot.serverNow >= gate.notBefore) return;
    await settle(120);
  }
}

/* ------------------------------------------------------------------ 等待 */

/**
 * 本页面上的一段落实时战斗阶段：阶段为 playing、
 * 竞技场已完成其异步初始化、目标已发布，且输入框接受输入。
 */
export async function waitForCombat(page: Page, timeout = 60_000): Promise<void> {
  await expect(battlePanel(page)).toHaveAttribute('data-phase', 'playing', { timeout });
  await expect(page.getByTestId('battle-canvas-wrap')).toHaveAttribute(
    'data-stage',
    /ready|degraded/,
    { timeout },
  );
  await expect(battlePanel(page)).toHaveAttribute('data-render', /canvas|dom/, { timeout });
  await expect(typingInput(page)).toBeEditable({ timeout });
  await expect.poll(() => spellText(page), { timeout }).not.toBe('');
}

/** 等待直到对局已结算（阶段为 finished、名次已发布）。 */
export async function waitForMatchEnd(page: Page, timeout = 120_000): Promise<void> {
  await expect(battlePanel(page)).toHaveAttribute('data-phase', 'finished', { timeout });
  await expect(page.getByTestId('final-panel')).toBeVisible({ timeout });
}

/* ------------------------------------------------------------------ 输入 */

/** 聚焦输入框，把光标移到已提交文本之后，并以全速输入。 */
export async function typeText(page: Page, text: string): Promise<void> {
  const input = typingInput(page);
  await input.click();
  await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.type(text, { delay: 0 });
}

/** 在光标/选区处输入而不点击，使既有选区得以保留。 */
export async function insertIntoField(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 0 });
}

export async function backspace(page: Page, times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) await page.keyboard.press('Backspace');
}

/** 通过键盘清空输入框，无论其中当前有何内容。 */
async function clearField(page: Page): Promise<void> {
  const input = typingInput(page);
  await input.click();
  await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.setSelectionRange(0, field.value.length);
  });
  await backspace(page, 1);
}

/* ------------------------------------------------------------- 完成施法 */

/**
 * 等待直到观察者自身的咒文游标已越过 `completedIndex`，
 * 或对局在能够推进之前就已结算（结束对局的那次完成也会推进游标，因此两者都接受）。
 */
async function waitForAdvanceOrEnd(
  page: Page,
  completedIndex: number,
  timeout = ACK_TIMEOUT,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await battlePhase(page)) === 'finished') return 'finished';
        return (await selfSpellIndex(page)) > completedIndex ? 'advanced' : 'waiting';
      },
      { timeout },
    )
    .not.toBe('waiting');
}

/**
 * 基于输入框当前已有的内容补完这道未完成的咒文：
 * 只插入权威目标中缺失的后缀，因此被恢复的已接受草稿绝不会被重复输入。
 * 这里触发的是浏览器的 input 事件，而不是粘贴或直接的 WebSocket/API 捷径。
 * 仅当服务端推进观察者的游标（或结束对局）时才完成。
 *
 * 补完是合法输入：先等待该观察者自身的门槛表明这道咒文的时间下限已过
 * （绝不写死 sleep，也绝不在客户端猜测 35ms）。
 * 等待期间对局结算并非错误 —— 循环调用方把已结束的对局视为完成。
 */
export async function completeSpell(page: Page): Promise<string> {
  if ((await battlePhase(page)) === 'playing') {
    try {
      await waitForInputGate(page);
    } catch (error) {
      if ((await battlePhase(page)) !== 'finished') throw error;
    }
  }
  const text = await spellText(page);
  const index = await selfSpellIndex(page);
  const current = await inputValue(page);
  if (current !== '' && !text.startsWith(current)) await clearField(page);
  const committed = await inputValue(page);
  const missing = text.startsWith(committed) ? text.slice(committed.length) : text;
  if (missing !== '') {
    const input = typingInput(page);
    await input.focus();
    await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await page.keyboard.insertText(missing);
  }
  await waitForAdvanceOrEnd(page, index);
  return text;
}

/**
 * 持续打出真实咒文，直到 `userId` 的席位出局。
 * 伤害由房间依据攻击者实际完成的咒文计算，
 * 因此该循环由观测到的生命值驱动，而不是靠算术推算。
 */
export async function defeatSeat(page: Page, userId: string, maxSpells = 40): Promise<number> {
  let cast = 0;
  while (cast < maxSpells) {
    if ((await battlePhase(page)) !== 'playing') break;
    const hpBefore = (await seatHealth(page, userId)).hp;
    if (hpBefore <= 0) break;
    await completeSpell(page);
    cast += 1;
    // 游标确认先于伤害到达。在决定是否需要再施法之前先观测这次齐射，
    // 否则一份迟到的快照可能直接击杀下一个席位。
    await expect
      .poll(
        async () =>
          (await battlePhase(page)) !== 'playing' || (await seatHealth(page, userId)).hp < hpBefore,
        { timeout: ACK_TIMEOUT },
      )
      .toBe(true);
  }
  if ((await seatHealth(page, userId)).hp > 0 && (await battlePhase(page)) === 'playing') {
    throw new Error(
      `seat ${userId} still has ${(await seatHealth(page, userId)).hp} HP after ${cast} completed spells`,
    );
  }
  return cast;
}

/** 持续打出真实咒文，直到对局结算（最后一名对手倒下或时间耗尽）。 */
export async function playUntilFinished(page: Page, maxSpells = 60): Promise<number> {
  let cast = 0;
  while (cast < maxSpells && (await battlePhase(page)) !== 'finished') {
    await completeSpell(page);
    cast += 1;
  }
  if ((await battlePhase(page)) !== 'finished')
    throw new Error(`match still live after ${cast} completed spells`);
  return cast;
}

/** 完成 `text` 这道咒文对剩余 `remainingHp` 的目标造成的伤害（以该值为上限）。 */
export function completionDamage(text: string, remainingHp = Number.POSITIVE_INFINITY): number {
  return Math.min(DAMAGE_PER_CHARACTER * Array.from(text).length, remainingHp);
}
