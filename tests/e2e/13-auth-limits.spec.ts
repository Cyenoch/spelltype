/**
 * Spec 13 — authentication budget.
 *
 * Runs against the dedicated `app-limit` instance, which keeps the production rate-limit
 * budget (10 requests / 60s for the local IP). The general instances run with a larger
 * test-only budget on their isolated runtime because this suite registers dozens of accounts
 * from one IP; the product configuration is unchanged.
 *
 * The budget must be spent before password verification, so once it is exhausted even a
 * correct password is refused: a brute-force attempt cannot slip a successful guess past
 * the limit.
 */
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../support/test';
import { fixture, freshAuthWindow, LIMITER_INSTANCE, runtime } from '../support/runtime';
import { PASSWORD, newContext, openHome, testId, uniqueName } from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

function authUrl(pathname: string): string {
  return new URL(pathname, runtime().limitAppUrl).toString();
}

async function register(request: APIRequestContext, username: string, password = PASSWORD): Promise<number> {
  const response = await request.post(authUrl('/api/register'), {
    headers: { origin: new URL(runtime().limitAppUrl).origin, 'content-type': 'application/json' },
    data: { username, password },
  });
  return response.status();
}

async function login(request: APIRequestContext, username: string, password = PASSWORD): Promise<number> {
  const response = await request.post(authUrl('/api/login'), {
    headers: { origin: new URL(runtime().limitAppUrl).origin, 'content-type': 'application/json' },
    data: { username, password },
  });
  return response.status();
}

test('认证预算耗尽后所有尝试（含正确凭据）都被 429 拒绝', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const account = uniqueName('limit');

  // Wait for a genuinely fresh 60s window instead of touching the real limit.
  await freshAuthWindow(LIMITER_INSTANCE);
  expect(await register(request, account), 'the first registration should succeed while the budget lasts').toBe(200);

  // The limiter keys are `register:<ip>` and `login:<ip>`: each budget is exhausted separately.
  const exhaust = async (attempt: () => Promise<number>, accepted: number[]): Promise<void> => {
    let limited = false;
    for (let index = 0; index < 20 && !limited; index += 1) {
      const status = await attempt();
      if (status === 429) limited = true;
      else expect(accepted, `unexpected status ${status} while spending the budget`).toContain(status);
    }
    expect(limited, 'the auth budget must be enforced in local development too').toBe(true);
  };

  // Login budget: after exhaustion a CORRECT password is refused too, so no guessed credential
  // can slip past the limit.
  await exhaust(() => login(request, account, PASSWORD), [200]);
  expect(await login(request, account, PASSWORD)).toBe(429);
  expect(await login(request, account, 'wrong-guess-0000')).toBe(429);

  // Register budget: spent independently of the login budget, with bounded invalid attempts.
  await exhaust(() => register(request, account), [200, 409]);
  expect(await register(request, uniqueName('limit2'))).toBe(429);
  // The login budget is still spent as well.
  expect(await login(request, account, PASSWORD)).toBe(429);

  // The refusal is a JSON error the UI can show, not an opaque failure.
  const refused = await request.post(authUrl('/api/login'), {
    headers: { origin: new URL(runtime().limitAppUrl).origin, 'content-type': 'application/json' },
    data: { username: account, password: PASSWORD },
  });
  expect(refused.headers()['content-type']).toContain('application/json');
  expect(typeof ((await refused.json()) as { error: string }).error).toBe('string');

  // And the browser surfaces it to the player instead of hanging silently.
  const context = await newContext(browser, { baseUrl: runtime().limitAppUrl });
  const page = await context.newPage();
  await openHome(page);
  await testId(page, 'home-auth').click();
  await testId(page, 'auth-mode-login').click();
  await testId(page, 'auth-username').fill(account);
  await testId(page, 'auth-password').fill(PASSWORD);
  await testId(page, 'auth-submit').click();
  await expect(page.getByTestId('auth-error').or(page.getByTestId('toast')).first()).not.toBeEmpty({ timeout: 20_000 });

  await context.close();
});
