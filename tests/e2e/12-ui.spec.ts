/**
 * Spec 12 — assets and real rendering on the canvas arena, accessibility, and the reduced-motion /
 * blocked-asset / small-screen / no-GPU adaptations.
 *
 * Every visual claim is grounded in something the page really did: an asset that loaded from
 * `/assets/`, a stage that reported its own readiness and renderer, a counter the renderer
 * increments when it animates a hit or a typing effect, a frame/paint counter that shows whether
 * the ticker is running, or pixels read back from the canvas. Nothing here asserts an animation
 * engine's internals, and nothing monkeypatches the platform except the deliberate browser launch
 * flags of the no-GPU spec.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { chromium, expect, test } from '../support/test';
import { fixture, runtime } from '../support/runtime';
import { decodePng, imageDigest, pixelStats } from '../support/png';
import {
  battleRender,
  completeSpell,
  completionDamage,
  hitsRendered,
  inputValue,
  onDemandPaints,
  rendererKind,
  roomSnapshot,
  seatHealth,
  snapshotPlayer,
  spellChars,
  spellText,
  tickerFrames,
  typeText,
  typingEffects,
  waitForCombat,
  waitForCombatDom,
  waitForHit,
} from '../support/combat';
import {
  DESKTOP_VIEWPORT,
  createRoom,
  gotoApp,
  newContext,
  openAuth,
  openHome,
  selfIdentity,
  setReady,
  settle,
  signOut,
  signUp,
  signedInContext,
  startMatch,
  testId,
  twoPlayerRoom,
  uniqueName,
  visibleErrorText,
  waitForLobbyPlayers,
} from '../support/ui';

const EVIDENCE_DIR = path.join(process.cwd(), 'tests', '.state', 'artifacts', 'visual');

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The visible part of an element, clamped to the viewport so a screenshot clip is always valid. */
async function visibleClip(locator: Locator, viewport = DESKTOP_VIEWPORT): Promise<Clip> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box to capture');
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(box.width), viewport.width - x)),
    height: Math.max(1, Math.min(Math.round(box.height), viewport.height - y)),
  };
}

async function digestOf(page: Page, clip: Clip): Promise<string> {
  return imageDigest(decodePng(await page.screenshot({ clip })));
}

/** The home backdrop host: its own declared motion mode, no render counters of its own. */
async function backdropMotion(page: Page): Promise<string> {
  return (await page.locator('#fx-layer').getAttribute('data-motion')) ?? '';
}

function saveEvidence(page: Page, name: string): Promise<Buffer> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

interface ImageLoad {
  url: string;
  status: number;
  type: string;
  bytes: number;
}

function collectImages(page: Page): ImageLoad[] {
  const loads: ImageLoad[] = [];
  page.on('response', (response) => {
    const type = response.headers()['content-type'] ?? '';
    if (!type.startsWith('image/')) return;
    // ImageBitmap loading can leave Playwright without a retrievable body even
    // though Chromium completed the image fetch; measure the actual transfer.
    void response.request()
      .sizes()
      .then(({ responseBodySize }) => loads.push({ url: response.url(), status: response.status(), type, bytes: responseBodySize }))
      .catch(() => {});
  });
  return loads;
}

/** Assets that really loaded, by the directory the art pipeline ships them in. */
function loadedFrom(loads: ImageLoad[], folder: string): ImageLoad[] {
  return loads.filter((image) => image.status === 200 && image.bytes > 500 && image.url.includes(`/assets/${folder}/`));
}

test('竞技场加载真实素材，画布渲染生成的角色并给出逐字与命中反馈', async ({ browser }) => {
  test.setTimeout(400_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  const images = collectImages(page);
  await openHome(page);
  await signUp(page, uniqueName('vis'));

  // The home backdrop is a real Pixi canvas inside #fx-layer: it paints and its ticker runs.
  const backdrop = page.locator('#fx-layer canvas').first();
  await expect(backdrop).toBeVisible({ timeout: 30_000 });
  const backdropBox = await backdrop.boundingBox();
  expect(backdropBox!.width).toBeGreaterThan(100);
  expect(backdropBox!.height).toBeGreaterThan(100);
  const backdropStats = pixelStats(decodePng(await page.screenshot({ clip: await visibleClip(backdrop) })));
  expect(backdropStats.distinct).toBeGreaterThan(20);
  expect(backdropStats.stddev).toBeGreaterThan(3);
  // With normal motion the backdrop really animates: its pixels change over time. The strip is the
  // canvas' own box, and the only animating thing inside it is the backdrop.
  expect(await backdropMotion(page)).toBe('full');
  const homeFrame = await digestOf(page, await visibleClip(backdrop));
  await settle(700);
  expect(await digestOf(page, await visibleClip(backdrop)), 'the backdrop must keep animating').not.toBe(homeFrame);
  // The declared background art of this page really loaded (the home backdrop uses ASSETS.background,
  // not the arena sprites the battle stage fetches).
  await expect.poll(() => loadedFrom(images, 'bg').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await saveEvidence(page, 'home.png');

  const room = await twoPlayerRoom(browser, { theme: '画面契约', difficulty: 'easy' });
  const host = room.host.page;
  const guest = room.guest.page;
  const guestIdentity = await selfIdentity(room.guest.context);
  // The battle art is fetched by the battle page, so its network is captured on that page and only
  // from before the match starts — the home page above never loads a character sprite.
  const battleImages = collectImages(host);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  // The battle stage reports its own asynchronous readiness and the renderer it selected, and the
  // generated character art really reached the browser.
  const wrap = testId(host, 'battle-canvas-wrap');
  await expect(wrap).toHaveAttribute('data-stage', /ready|degraded/);
  expect(await battleRender(host)).toBe('canvas');
  await expect.poll(() => loadedFrom(battleImages, 'characters').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const arenaCanvas = wrap.locator('canvas').first();
  await expect(arenaCanvas).toBeVisible();
  const arenaBox = await arenaCanvas.boundingBox();
  expect(arenaBox!.width).toBeGreaterThan(300);
  expect(arenaBox!.height).toBeGreaterThan(200);
  const arenaStats = pixelStats(decodePng(await host.screenshot({ clip: await visibleClip(wrap) })));
  expect(arenaStats.distinct).toBeGreaterThan(10);

  // One seat per real participant, each with a live health bar.
  expect(await testId(host, 'arena-seat').count()).toBe(2);
  expect(await seatHealth(host, guestIdentity.userId)).toEqual({ hp: INITIAL_HEALTH, maxHp: INITIAL_HEALTH });

  // Legibility contract, measured side: an easy book is 18-26 characters per spell and the rendered
  // target only wraps past 32 characters at any desktop width >=1024, so this band must stay on one
  // line with real margin. The value is measured when the target is bound and re-measured on a
  // resize, so it is final by the time the phase is playing.
  // The wrapped side is deliberately NOT pinned here: the boundary moves with font metrics, and this
  // fixture's hard band (39-50, and exactly 39 in its first book) sits inside the range the renderer
  // owner measured as viewport dependent. A flip of this assertion would mean either a ~20% font
  // advance-width change or an easy spell longer than 32 characters — both real defects worth failing.
  await expect(testId(host, 'battle-panel')).toHaveAttribute('data-long-target', 'false');

  // Typing classifies the generated characters against the authoritative target, and the stage
  // really animates the typing effect for the confirmed prefix.
  const text = await spellText(host);
  const typingBefore = await typingEffects(host);
  await typeText(host, text.slice(0, 6));
  await expect.poll(async () => (await spellChars(host)).ok, { timeout: 20_000 }).toBe(6);
  const typing = await spellChars(host);
  expect(typing.cur).toBe(1);
  expect(typing.err).toBe(0);
  await expect.poll(() => typingEffects(host), 'typing effects must really be rendered').toBeGreaterThan(typingBefore);

  // A wrong character is shown as an error and can be removed again.
  await typeText(host, '错');
  await expect.poll(async () => (await spellChars(host)).err, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await host.keyboard.press('Backspace');
  await expect.poll(async () => (await spellChars(host)).err, { timeout: 20_000 }).toBe(0);

  // Completing the spell is acknowledged by the server, which is what the visual feedback follows.
  const guestHpBefore = (await seatHealth(host, guestIdentity.userId)).hp;
  const arenaBeforeHit = await digestOf(host, await visibleClip(wrap));
  expect(await completeSpell(host)).toBe(text);
  await waitForHit(host, 1);
  expect(await hitsRendered(host)).toBeGreaterThanOrEqual(1);
  expect((await seatHealth(host, guestIdentity.userId)).hp).toBe(guestHpBefore - completionDamage(text));
  // The arena repainted across the hit; the hit counter above is what attributes the change.
  expect(await digestOf(host, await visibleClip(wrap))).not.toBe(arenaBeforeHit);
  await expect(testId(host, 'graphics-warning')).toBeHidden();
  await saveEvidence(host, 'battle.png');

  // The advance clears the field and opens the next spell.
  await expect.poll(() => inputValue(host)).toBe('');

  // A reload during a live match repaints the arena from the snapshot instead of a blank frame.
  await host.reload();
  await waitForCombat(host);
  expect(await battleRender(host)).toBe('canvas');
  expect(await testId(host, 'arena-seat').count()).toBe(2);
  await expect(testId(host, 'battle-canvas-wrap')).toHaveAttribute('data-stage', /ready|degraded/);
  const afterReload = pixelStats(decodePng(await host.screenshot({ clip: await visibleClip(testId(host, 'battle-canvas-wrap')) })));
  expect(afterReload.distinct).toBeGreaterThan(10);

  await room.host.context.close();
  await room.guest.context.close();
  await context.close();
});

test('减少动画模式下画布保持静态，但状态变化时仍会重绘', async ({ browser }) => {
  test.setTimeout(300_000);
  // The whole scenario runs in reduced-motion contexts: the static ticker and the on-demand repaint
  // after a real state change are both judged on pages that declare the mode.
  const hostContext = await newContext(browser, { reducedMotion: 'reduce' });
  const hostPage = await hostContext.newPage();
  await openHome(hostPage);
  const hostName = uniqueName('calm');
  await signUp(hostPage, hostName);
  expect(await hostPage.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced');

  const backdrop = hostPage.locator('#fx-layer canvas').first();
  await expect(backdrop).toBeVisible({ timeout: 30_000 });
  expect(await backdropMotion(hostPage)).toBe('reduced');
  const homeFrame = await digestOf(hostPage, await visibleClip(backdrop));
  await settle(1200);
  expect(await digestOf(hostPage, await visibleClip(backdrop)), 'the backdrop must be static under reduced motion').toBe(homeFrame);

  const roomId = await createRoom(hostPage, { theme: '静默契约', difficulty: 'easy' });
  const guestContext = await newContext(browser, { reducedMotion: 'reduce' });
  const guestPage = await guestContext.newPage();
  await openHome(guestPage);
  const guestName = uniqueName('calmg');
  await signUp(guestPage, guestName);
  expect(await guestPage.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced');
  await gotoApp(guestPage, `/?room=${roomId}`);
  await waitForLobbyPlayers(hostPage, [hostName, guestName]);
  await setReady(guestPage, true);

  await startMatch(hostPage);
  await Promise.all([waitForCombat(hostPage), waitForCombat(guestPage)]);
  const standingFrames = await tickerFrames(hostPage);
  const standingPaints = await onDemandPaints(hostPage);
  await expect(testId(hostPage, 'battle-canvas-wrap')).toHaveAttribute('data-motion', 'reduced');
  // With the ticker stopped, time passing on its own adds no ticker frames; on-demand repaints are
  // checked below, where a real state change happens.
  await settle(1200);
  expect(await tickerFrames(hostPage), 'the battle ticker must be stopped under reduced motion').toBe(standingFrames);

  // A real state change still renders: typing repaints on demand and the effect is really drawn,
  // all while the ticker stays stopped and the page still declares the mode it rendered under.
  const text = await spellText(hostPage);
  const typingBefore = await typingEffects(hostPage);
  await typeText(hostPage, text);
  await expect.poll(() => onDemandPaints(hostPage), 'a confirmed keystroke must repaint').toBeGreaterThan(standingPaints);
  await waitForHit(hostPage, 1);
  expect(await typingEffects(hostPage)).toBeGreaterThan(typingBefore);
  expect(await hitsRendered(hostPage)).toBeGreaterThanOrEqual(1);
  expect(await hostPage.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced');
  expect(await tickerFrames(hostPage), 'the ticker stays flat even after a state change').toBe(standingFrames);

  await hostContext.close();
  await guestContext.close();
});

test('键盘可达、控件有可访问名称，错误不只依赖颜色', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, username } = await signedInContext(browser, 'a11y');

  const focusSequence: string[] = [];
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press('Tab');
    focusSequence.push(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.testid ?? document.activeElement?.tagName ?? ''));
  }
  expect(focusSequence.some((entry) => ['home-auth', 'home-create', 'home-quick-start', 'home-profile', 'sign-out'].includes(entry))).toBe(true);
  const focusStyle = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return `${style.outlineStyle}|${style.boxShadow}`;
  });
  expect(focusStyle).not.toBe('none|none');

  // The auth dialog is only reachable once signed out (home-auth is hidden while signed in).
  await signOut(page);
  await openAuth(page);
  const snapshot = await page.locator('#app').ariaSnapshot();
  expect(snapshot).toMatch(/textbox/);
  expect(snapshot).toMatch(/button/);

  // Errors are announced as text, not only as colour.
  await testId(page, 'auth-mode-login').click();
  await testId(page, 'auth-password').fill('wrong-password-9999');
  await testId(page, 'auth-username').fill(username);
  await testId(page, 'auth-submit').click();
  await expect.poll(() => visibleErrorText(page), { timeout: 20_000 }).not.toBe('');
  const liveRegions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).filter((element) => (element.textContent ?? '').trim().length > 0).length,
  );
  expect(liveRegions).toBeGreaterThan(0);

  await context.close();
});

test('素材加载失败时给出渲染失败提示，且纯 DOM 界面仍能完整对战', async ({ browser }) => {
  test.setTimeout(300_000);
  // Real browser network policy, not a mocked platform: every static asset path is blocked before
  // the app loads, so Pixi's asset loader fails for real (Vite serves client modules from /src and
  // /node_modules, so the application itself still loads and runs).
  /**
   * Refuse every image request in a context, so the graphics stage really cannot load its art.
   * Routing is used rather than CDP URL patterns because it is deterministic and, crucially, lets
   * the spec observe that the block actually applied: the refused URLs are recorded and asserted,
   * so this scenario can never pass while the app was quietly serving its art.
   */
  const refuseImages = async (context: BrowserContext): Promise<string[]> => {
    const refused: string[] = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (!/\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(url)) return route.continue();
      refused.push(url);
      return route.abort('failed');
    });
    return refused;
  };

  const context = await newContext(browser);
  const page = await context.newPage();
  const guestContext = await newContext(browser);
  try {
    const refused = await refuseImages(context);
    await openHome(page);

    // The failure must be surfaced, not silently swallowed.
    await expect(testId(page, 'graphics-warning')).toBeVisible({ timeout: 40_000 });
    await expect(testId(page, 'app-root')).toHaveAttribute('data-graphics', 'failed');
    await expect.poll(() => visibleErrorText(page), { timeout: 20_000 }).toContain('图形');
    // The premise of this spec: art requests really were refused (a zero here would mean the app
    // never asked for the blocked images, which would make the failure assertion meaningless).
    expect(refused.length, 'no image request was refused by the blocked-asset setup').toBeGreaterThan(0);

    // The DOM product stays usable end to end: account, room, match, typing and combat.
    const username = uniqueName('noasset');
    await signUp(page, username);
    const roomId = await createRoom(page, { theme: '素材缺失契约', difficulty: 'easy' });

    const guestRefused = await refuseImages(guestContext);
    const guestPage = await guestContext.newPage();
    await openHome(guestPage);
    const guestName = uniqueName('noasset2');
    await signUp(guestPage, guestName);
    await gotoApp(guestPage, `/?room=${roomId}`);
    await waitForLobbyPlayers(page, [username, guestName]);
    await setReady(guestPage, true);

    await startMatch(page);
    await Promise.all([waitForCombatDom(page), waitForCombatDom(guestPage)]);
    // Both clients were really cut off from their art, not merely one of them.
    expect(guestRefused.length, 'the guest client refused no image request').toBeGreaterThan(0);

    // The arena keeps its complete DOM overlay, so seats, health and the target stay observable.
    expect(await testId(page, 'arena-seat').count()).toBe(2);
    expect(await battleRender(page)).toBe('dom');
    const guestIdentity = await selfIdentity(guestContext);
    expect(await seatHealth(page, guestIdentity.userId)).toEqual({ hp: INITIAL_HEALTH, maxHp: INITIAL_HEALTH });
    const text = await spellText(page);
    expect(await spellText(guestPage)).toBe(text);
    expect(await inputValue(page)).toBe('');

    const before = snapshotPlayer(await roomSnapshot(guestContext, roomId), guestIdentity).hp;
    expect(await completeSpell(page)).toBe(text);
    await expect
      .poll(async () => snapshotPlayer(await roomSnapshot(guestContext, roomId), guestIdentity).hp, { timeout: 30_000 })
      .toBe(before - completionDamage(text));
    // The defeated graphics layer never blocks the fight: the arena's own damage log records it.
    const entries = await testId(page, 'combat-log-entry').all();
    expect(entries).toHaveLength(1);
  } finally {
    // Closing the contexts also drops the CDP sessions and their blocking rules.
    await guestContext.close();
    await context.close();
  }
});

test('小屏幕只提供查看与提示，不宣称公平对战', async ({ browser }) => {
  test.setTimeout(180_000);
  const small = await newContext(browser, { viewport: { width: 390, height: 844 } });
  const smallPage = await small.newPage();
  await openHome(smallPage);
  await expect(testId(smallPage, 'small-screen-warning')).toBeVisible();
  await expect(testId(smallPage, 'view-home')).toBeVisible();
  await small.close();

  const desktop = await newContext(browser);
  const desktopPage = await desktop.newPage();
  await openHome(desktopPage);
  await expect(testId(desktopPage, 'small-screen-warning')).toBeHidden();
  await desktop.close();
});

test('GPU 不可用时 Canvas 回退仍能比赛并真实绘制', async () => {
  test.setTimeout(300_000);
  // Contract: with WebGL and WebGPU unavailable the app must degrade to the Canvas renderer and
  // stay fully playable — not merely avoid crashing. (The banner path for a machine where every
  // renderer is unavailable cannot be triggered in Chromium without mocking the platform, so it is
  // deliberately NOT asserted here; no platform monkeypatching is used anywhere in this suite.)
  const noGpuBrowser = await chromium.launch({
    args: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis', '--disable-webgpu', '--disable-features=WebGPU,WebGPUService', '--disable-gpu'],
  });
  const context = await noGpuBrowser.newContext({ baseURL: runtime().appUrl, viewport: DESKTOP_VIEWPORT });
  const page = await context.newPage();
  await openHome(page);
  // The backdrop is created asynchronously: wait for the application's own canvas instead of
  // inferring an init failure from its absence.
  await expect(page.locator('#fx-layer canvas').first()).toBeVisible({ timeout: 30_000 });

  // Positive probe of the environment on fresh canvases (a canvas locks its context type) plus the
  // application's own canvas: a canvas already bound to WebGL would refuse a 2D context, so a 2D
  // context on the app canvas is evidence that the Canvas renderer was selected.
  const probe = await page.evaluate(async () => {
    const gpuContexts: string[] = [];
    for (const kind of ['webgl2', 'webgl'] as const) {
      const canvas = document.createElement('canvas');
      if (canvas.getContext(kind)) gpuContexts.push(kind);
    }
    let adapter = false;
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu) {
      try {
        adapter = Boolean(await gpu.requestAdapter());
      } catch {
        adapter = false;
      }
    }
    const appCanvas = document.querySelector('#fx-layer canvas');
    return {
      gpuContexts,
      adapter,
      hasAppCanvas: appCanvas instanceof HTMLCanvasElement,
      appCanvasIs2d: appCanvas instanceof HTMLCanvasElement ? Boolean(appCanvas.getContext('2d')) : false,
    };
  });
  expect(probe.gpuContexts, 'WebGL must really be unavailable in this browser').toEqual([]);
  expect(probe.adapter, 'WebGPU must really be unavailable in this browser').toBe(false);
  expect(probe.hasAppCanvas).toBe(true);
  expect(probe.appCanvasIs2d, 'the app must have fallen back to the Canvas renderer').toBe(true);

  // No false failure banner, and the effective canvas really paints pixels.
  await expect(testId(page, 'graphics-warning')).toBeHidden();
  const canvasContent = await page.evaluate(() => {
    const canvas = document.querySelector('#fx-layer canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const probe = document.createElement('canvas');
    probe.width = Math.min(320, canvas.width);
    probe.height = Math.min(180, canvas.height);
    const ctx = probe.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set<string>();
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
      sum += luminance;
      sumSquares += luminance * luminance;
      count += 1;
    }
    const mean = sum / Math.max(1, count);
    return { colors: colors.size, stddev: Math.sqrt(Math.max(0, sumSquares / Math.max(1, count) - mean * mean)) };
  });
  expect(canvasContent).not.toBeNull();
  expect(canvasContent!.colors).toBeGreaterThan(3);
  expect(canvasContent!.stddev).toBeGreaterThan(1);

  // The game stays fully playable on the fallback renderer: register, host, join, start, fight.
  const username = uniqueName('canvas');
  await signUp(page, username);
  const roomId = await createRoom(page, { theme: '画布回退契约', difficulty: 'easy' });
  // The second client runs in the same GPU-less browser, so the fallback is proven on BOTH ends.
  const guest = await signedInContext(noGpuBrowser, 'canvas2');
  await gotoApp(guest.page, `/?room=${roomId}`);
  await waitForLobbyPlayers(page, [username, guest.username]);
  await setReady(guest.page, true);
  await startMatch(page);
  await Promise.all([waitForCombat(page), waitForCombat(guest.page)]);

  // The stage really selected the 2D Canvas renderer, and the arena is present on both clients.
  await expect(testId(page, 'battle-canvas-wrap')).toHaveAttribute('data-renderer', 'canvas');
  expect(await rendererKind(page)).toBe('canvas');
  expect(await battleRender(page)).toBe('canvas');
  expect(await testId(page, 'arena-seat').count()).toBe(2);
  expect(await testId(guest.page, 'arena-seat').count()).toBe(2);
  await expect(testId(page, 'countdown-display')).toBeAttached();

  const text = await spellText(page);
  expect(await spellText(guest.page)).toBe(text);
  const guestIdentity = await selfIdentity(guest.context);
  const guestHpBefore = (await seatHealth(page, guestIdentity.userId)).hp;
  expect(await completeSpell(page)).toBe(text);
  await waitForHit(page, 1);
  expect(await hitsRendered(page)).toBeGreaterThanOrEqual(1);
  expect((await seatHealth(page, guestIdentity.userId)).hp).toBe(guestHpBefore - completionDamage(text));
  expect(await rendererKind(guest.page)).toBe('canvas');
  await expect.poll(() => hitsRendered(guest.page)).toBeGreaterThanOrEqual(1);

  await guest.context.close();
  await context.close();
  await noGpuBrowser.close();
});
