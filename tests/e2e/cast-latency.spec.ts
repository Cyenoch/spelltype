import { expect } from '@playwright/test';
import { test } from '../support/test';
import { seatedRoom, startMatch } from '../support/lobby';
import { spellText, waitForCombat, waitForInputGate } from '../support/combat';
import { selfIdentity } from '../support/api';
import { receivedFrames } from '../support/wire';
import type { ClientMessage } from '../../shared/protocol';

for (const count of [2, 4]) {
  test(`${count} 人持续输入后最后一字及时产生攻击，停笔仍广播进度`, async ({ browser }) => {
    const room = await seatedRoom(browser, count, { theme: '施法延迟回归', sockets: true });
    try {
      await startMatch(room.host.page);
      await Promise.all(room.sessions.map(({ page }) => waitForCombat(page)));
      await Promise.all(room.sessions.map(({ page }) => waitForInputGate(page)));
      const captures = [room.hostSockets!, ...room.guestSockets.map((capture) => capture!)];
      const timings = await Promise.all(
        room.sessions.map(async ({ page, context }, index) => {
          const { userId } = await selfIdentity(context);
          const text = await spellText(page);
          const capture = captures[index];
          const attack = () =>
            receivedFrames(capture).find(
              ({ message }) =>
                message?.type === 'state' &&
                message.room.events.some((event) => event.attackerId === userId),
            );
          await page.getByTestId('typing-input').focus();
          // 每次编辑都必须保留；普通进度广播合并不能吞掉停笔前的最后一个字符。
          await page.keyboard.type(text.slice(0, 3), { delay: 55 });
          const observer = captures[(index + 1) % count];
          await expect
            .poll(() =>
              receivedFrames(observer).some(
                ({ message }) =>
                  message?.type === 'state' &&
                  message.room.players.some(
                    (player) => player.id === userId && player.progress === 3,
                  ),
              ),
            )
            .toBe(true);
          await page.keyboard.type(text.slice(3), { delay: 55 });
          await expect.poll(attack, { timeout: 10000 }).toBeDefined();
          const completed = capture.frames.find(({ direction, payload }) => {
            if (direction !== 'sent') return false;
            const message = JSON.parse(payload) as ClientMessage;
            return message.type === 'input' && message.text === text;
          })!;
          return attack()!.at - completed.at;
        }),
      );
      console.log(`${count} players: last character sent → authoritative attack (ms):`, timings);
      for (const elapsed of timings) expect(elapsed).toBeLessThan(500);
    } finally {
      await Promise.all(room.sessions.map(({ context }) => context.close()));
    }
  });
}
