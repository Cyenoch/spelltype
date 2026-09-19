import { expect } from '@playwright/test';
import { test } from '../support/test';
import { fixture } from '../support/runtime';
import { signedInContext } from '../support/session';

// 不可见的输入框必须暴露出所有已被接受的拼写错误，包括多余字符和空白字符。
test('练习显示连续错字与句尾多余字符，完成后回车继续', async ({ browser }) => {
  await fixture().reset();
  const session = await signedInContext(browser, 'practice');
  const { page } = session;
  await page.getByTestId('home-quick-start').click();
  const field = page.getByTestId('practice-input');
  const target = page.getByTestId('practice-target');
  await expect(field).toBeVisible();
  const sentence = (await page.getByTestId('practice-target-plain').textContent())!.replace(
    '目标咒文：',
    '',
  );

  await field.pressSequentially(sentence.slice(0, 4) + '###');
  await expect(target.locator('.ch--err')).toHaveCount(3);
  await expect(target.locator('.ch--err')).toHaveText(['#', '#', '#']);
  await expect(page.getByTestId('practice-target-error')).toContainText('输入了「#」');
  await expect(page.getByTestId('practice-target-error')).toContainText(
    `应输入「${sentence[6] === ' ' ? '空格' : sentence[6]}」`,
  );
  for (const remaining of [2, 1, 0]) {
    await field.press('Backspace');
    await expect(target.locator('.ch--err')).toHaveCount(remaining);
  }
  await expect(page.getByTestId('practice-error-rate')).toHaveText('42.9%');
  await expect(page.getByTestId('practice-target-error')).toBeHidden();

  await field.pressSequentially(sentence.slice(4, -1) + '###');
  await expect(target.locator('.ch--err')).toHaveCount(3);
  await expect(target.locator('[data-extra]')).toHaveText('##');
  await expect(page.getByTestId('practice-target-error')).toContainText('多余字符「#」');
  for (const remaining of [2, 1, 0]) {
    await field.press('Backspace');
    await expect(target.locator('.ch--err')).toHaveCount(remaining);
  }
  await field.pressSequentially(sentence.slice(-1));
  await expect(page.getByTestId('practice-completed')).toHaveText('1 句');
  await expect(page.getByTestId('practice-target-complete')).toBeVisible();
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await expect(page.getByTestId('practice-target-plain')).not.toHaveText(`目标咒文：${sentence}`);
  await expect(page.getByTestId('practice-completed')).toHaveText('1 句');
  await field.pressSequentially(' ');
  await expect(target.locator('.ch--err')).toHaveText('␣');
  await expect(page.getByTestId('practice-target-error')).toContainText('输入了「空格」');
  await field.press('Backspace');
  await expect(page.getByTestId('practice-target-error')).toBeHidden();
  await page.getByTestId('queue-cancel').click();
  await expect(field).toBeDisabled();
  await session.context.close();
});
