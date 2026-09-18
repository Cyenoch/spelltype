/**
 * Spec 1 — accounts, sessions and secret isolation, observed from the browser.
 */
import { expect, test } from '../support/test';
import { openD1 } from '../support/d1';
import { TEST_AI_KEY } from '../support/harness';
import { fixture, runtime } from '../support/runtime';
import {
  apiJson,
  createRoom,
  expectSignedOut,
  newContext,
  openHome,
  PASSWORD,
  signIn,
  signOut,
  signedInContext,
  testId,
  uniqueName,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('注册建立会话、刷新保持登录、登出后会话与受保护接口失效', async ({ browser }) => {
  const { context, page, username } = await signedInContext(browser, 'auth');

  await page.reload();
  await expect(testId(page, 'nav-username')).toHaveText(username);
  expect((await apiJson(context, '/api/profile')).status).toBe(200);

  await signOut(page);
  await page.reload();
  await expectSignedOut(page);
  expect((await apiJson(context, '/api/profile')).status).toBe(401);

  // The same credentials still work after signing out.
  await signIn(page, username);
  expect((await apiJson(context, '/api/profile')).status).toBe(200);
  await context.close();
});

test('重复用户名与错误密码给出可见错误且不建立会话', async ({ browser }) => {
  const first = await signedInContext(browser, 'dup');

  const duplicate = await newContext(browser);
  const duplicatePage = await duplicate.newPage();
  await openHome(duplicatePage);
  await testId(duplicatePage, 'home-auth').click();
  await testId(duplicatePage, 'auth-mode-register').click();
  await testId(duplicatePage, 'auth-username').fill(first.username);
  await testId(duplicatePage, 'auth-password').fill('another-password-123');
  await testId(duplicatePage, 'auth-submit').click();
  await expect(testId(duplicatePage, 'auth-error')).toBeVisible();
  await expect(testId(duplicatePage, 'auth-error')).not.toBeEmpty();
  await expect(testId(duplicatePage, 'nav-username')).toBeHidden();
  expect((await apiJson(duplicate, '/api/profile')).status).toBe(401);

  const wrongPassword = await newContext(browser);
  const wrongPage = await wrongPassword.newPage();
  await openHome(wrongPage);
  await testId(wrongPage, 'home-auth').click();
  await testId(wrongPage, 'auth-password').fill('definitely-not-the-password');
  await testId(wrongPage, 'auth-username').fill(first.username);
  await testId(wrongPage, 'auth-submit').click();
  await expect(testId(wrongPage, 'auth-error')).toBeVisible();
  await expect(testId(wrongPage, 'auth-error')).not.toBeEmpty();
  await expect(testId(wrongPage, 'nav-username')).toBeHidden();

  await duplicate.close();
  await wrongPassword.close();
  await first.context.close();
});

test('未登录时受保护接口与房间 WebSocket 均被拒绝', async ({ browser }) => {
  const owner = await signedInContext(browser, 'own');
  const roomId = await createRoom(owner.page, { theme: '准入试炼', difficulty: 'easy' });

  const anonymous = await newContext(browser);
  const page = await anonymous.newPage();
  await openHome(page);

  expect((await apiJson(anonymous, '/api/profile')).status).toBe(401);
  expect((await apiJson(anonymous, `/api/rooms/${roomId}`)).status).toBe(401);
  expect((await apiJson(anonymous, '/api/rooms', { method: 'POST', data: { theme: '无权限', difficulty: 'easy' } })).status).toBe(401);
  expect((await apiJson(anonymous, '/api/match', { method: 'POST', data: { difficulty: 'easy' } })).status).toBe(401);

  const socketResult = await page.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/api/rooms/${id}/ws`);
        socket.onopen = () => resolve('open');
        socket.onclose = (event) => resolve(`close:${event.code}`);
        socket.onerror = () => resolve('error');
        setTimeout(() => resolve('timeout'), 8000);
      }),
    roomId,
  );
  expect(socketResult).not.toBe('open');

  // Unknown room ids never create a usable room either.
  const unknown = await apiJson(owner.context, '/api/rooms/0123456789abcdef01234567');
  expect(unknown.status).toBeGreaterThanOrEqual(400);
  await anonymous.close();
  await owner.context.close();
});

test('会话过期后被拒绝，重新登录仍可用', async ({ browser }) => {
  const { context, page, username } = await signedInContext(browser, 'exp');

  const db = await openD1(runtime().persistDir);
  await db.run('UPDATE sessions SET expires_at = 1');

  expect((await apiJson(context, '/api/profile')).status).toBe(401);
  await page.reload();
  await expectSignedOut(page);

  await signIn(page, username);
  expect((await apiJson(context, '/api/profile')).status).toBe(200);
  await context.close();
});

test('AI 状态按实例如实上报，密钥不进入响应或客户端代码', async ({ browser }) => {
  const { context } = await signedInContext(browser, 'sec');
  const session = await apiJson<{ user: unknown; aiConfigured: boolean }>(context, '/api/session');
  expect(Object.keys(session.body).sort()).toEqual(['aiConfigured', 'user']);
  expect(session.body.aiConfigured).toBe(true);
  expect(JSON.stringify(session.body)).not.toContain(TEST_AI_KEY);

  const anonymous = await newContext(browser);
  const noKey = await apiJson<{ aiConfigured: boolean }>(anonymous, new URL('/api/session', runtime().noKeyAppUrl).toString());
  expect(noKey.body.aiConfigured).toBe(false);

  const needles = [TEST_AI_KEY, 'TEST_DEEPSEEK_BASE_URL'];
  const roots = [new URL('/src/main.ts', runtime().appUrl).toString(), new URL('/', runtime().appUrl).toString()];
  const visited = new Set<string>();
  const queue = [...roots];
  const leaked: string[] = [];
  while (queue.length > 0 && visited.size < 40) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const response = await context.request.get(url);
    if (!response.ok()) continue;
    const body = await response.text();
    for (const needle of needles) if (body.includes(needle)) leaked.push(`${url} contains ${needle}`);
    for (const match of body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('/src/') && !specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      queue.push(new URL(specifier, url).toString());
    }
  }
  expect(leaked).toEqual([]);
  expect(visited.size).toBeGreaterThan(1);

  await anonymous.close();
  await context.close();
});

test('同源校验按 scheme+host 生效，异常请求不产生 5xx', async ({ browser, request }) => {
  const { context } = await signedInContext(browser, 'app');
  const appUrl = runtime().appUrl;
  const origin = new URL(appUrl).origin;

  const stateChanging = { data: { theme: '同源契约', difficulty: 'easy' as const } };
  const foreign = await apiJson(context, new URL('/api/rooms', appUrl).toString(), { ...stateChanging, method: 'POST', origin: 'https://evil.example' });
  expect(foreign.status).toBe(403);
  const schemeMismatch = await apiJson(context, new URL('/api/rooms', appUrl).toString(), { ...stateChanging, method: 'POST', origin: origin.replace('http://', 'https://') });
  expect(schemeMismatch.status).toBe(403);
  const sameOrigin = await apiJson(context, new URL('/api/rooms', appUrl).toString(), { ...stateChanging, method: 'POST' });
  expect(sameOrigin.status).toBe(200);

  const noOrigin = await request.post(new URL('/api/rooms', appUrl).toString(), { headers: { 'content-type': 'application/json' }, data: stateChanging.data });
  expect(noOrigin.status()).toBe(403);

  // Malformed cookies are handled gracefully instead of crashing the request.
  for (const cookie of ['spelltype_session=%%%not-a-token%%%', 'spelltype_session', 'spelltype_session=', 'other=1; spelltype_session=']) {
    const session = await request.get(new URL('/api/session', appUrl).toString(), { headers: { cookie } });
    expect(session.status(), cookie).toBeLessThan(500);
    expect(((await session.json()) as { user: unknown }).user).toBeNull();
    const profile = await request.get(new URL('/api/profile', appUrl).toString(), { headers: { cookie } });
    expect(profile.status(), cookie).toBeLessThan(500);
  }

  // Body caps apply to streamed (chunked) requests without a Content-Length too.
  expect(await postChunked(new URL('/api/register', appUrl).toString(), origin, 'x'.repeat(9000))).toBe(413);
  const chunkedOk = await postChunked(
    new URL('/api/register', appUrl).toString(),
    origin,
    JSON.stringify({ username: uniqueName('chunky'), password: PASSWORD }),
  );
  expect(chunkedOk).toBe(200);

  await context.close();
});

/** POSTs a body as a stream, so the request arrives without a Content-Length header. */
async function postChunked(url: string, origin: string, body: string): Promise<number> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  return response.status;
}
