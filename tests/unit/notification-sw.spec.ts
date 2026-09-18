/**
 * The service worker's notification-click routing, driven directly against the
 * shipped `public/sw.js` source. This is the one piece of reminder behaviour a
 * headless browser cannot exercise (it cannot tap a real OS toast), so its
 * contract is pinned here: same-room window wins and is focused — never
 * navigated — the invite URL opens when no same-room window exists, and anything
 * expired, malformed or forged collapses to the origin root. The matcher must
 * include uncontrolled windows, or a first registration could never find the
 * page that registered it.
 */
import { describe, expect, it, mock, type Mock } from 'bun:test';
import { runInNewContext } from 'node:vm';

const ORIGIN = 'https://spelltype.test';
const ROOM_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

const SW_SOURCE = await Bun.file(new URL('../../public/sw.js', import.meta.url)).text();

/** A fake SW client window: its URL and a focus spy. */
interface FakeWindow {
  url: string;
  focus: Mock<() => Promise<void>>;
}

/** A spy function shape for `clients.matchAll` / `clients.openWindow`. */
type ClientSpy = Mock<(...args: unknown[]) => Promise<unknown>>;

interface SwHarness {
  dispatchClick: (data: unknown) => Promise<void>;
  matchAll: ClientSpy;
  openWindow: ClientSpy;
}

/** Evaluates the worker source once per case with fresh client stubs. */
function loadWorker(windows: FakeWindow[]): SwHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const matchAll = mock(async () => windows);
  const openWindow = mock(async () => undefined);
  const selfStub = {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      listeners.set(name, handler);
    },
    location: { origin: ORIGIN },
    clients: { matchAll, openWindow },
  };
  runInNewContext(SW_SOURCE, { self: selfStub, URL, Date });
  const handler = listeners.get('notificationclick');
  if (!handler) throw new Error('sw.js did not register notificationclick');
  return {
    matchAll,
    openWindow,
    dispatchClick: (data: unknown) => {
      const close = mock();
      const pending: Promise<unknown>[] = [];
      handler({
        notification: { close, data },
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      });
      expect(close).toHaveBeenCalledTimes(1);
      return Promise.all(pending).then(() => undefined);
    },
  };
}

function fakeWindow(url: string): FakeWindow {
  return { url, focus: mock(async () => undefined) };
}

function reminder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roomId: ROOM_ID,
    eventKey: `${ROOM_ID}:matched`,
    gen: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('sw.js notificationclick', () => {
  it('focuses the same-room window and never opens or navigates anything else', async () => {
    const room = fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`);
    const home = fakeWindow(`${ORIGIN}/`);
    const rival = fakeWindow(`${ORIGIN}/?room=${'f' + ROOM_ID.slice(1)}`);
    const worker = loadWorker([home, rival, room]);

    await worker.dispatchClick(reminder());

    expect(room.focus).toHaveBeenCalledTimes(1);
    expect(home.focus).not.toHaveBeenCalled();
    expect(rival.focus).not.toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it('finds uncontrolled windows: matchAll must include them', async () => {
    const worker = loadWorker([fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`)]);
    await worker.dispatchClick(reminder());
    expect(worker.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
  });

  it('opens the invite URL when no same-room window exists', async () => {
    const worker = loadWorker([fakeWindow(`${ORIGIN}/`), fakeWindow(`${ORIGIN}/?mode=login`)]);
    await worker.dispatchClick(reminder());
    expect(worker.openWindow).toHaveBeenCalledTimes(1);
    expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/?room=${ROOM_ID}`);
  });

  it('sends expired reminders to the origin root, ignoring a same-room window', async () => {
    const room = fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`);
    const worker = loadWorker([room]);
    await worker.dispatchClick(reminder({ expiresAt: Date.now() - 1 }));
    expect(room.focus).not.toHaveBeenCalled();
    expect(worker.openWindow).toHaveBeenCalledTimes(1);
    expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/`);
  });

  it('sends forged or malformed room data to the origin root', async () => {
    for (const data of [
      reminder({ roomId: 'javascript:alert(1)' }),
      reminder({ roomId: 'short' }),
      reminder({ roomId: ROOM_ID.toUpperCase() }),
      reminder({ expiresAt: 'not-a-number' }),
      undefined,
    ]) {
      const worker = loadWorker([]);
      await worker.dispatchClick(data);
      expect(worker.openWindow).toHaveBeenCalledTimes(1);
      expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/`);
    }
  });

  it('still opens the root when the same-room window refuses to focus', async () => {
    const room = fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`);
    room.focus.mockRejectedValueOnce(new Error('not focused'));
    const worker = loadWorker([room]);
    await worker.dispatchClick(reminder());
    expect(worker.openWindow).toHaveBeenCalledTimes(1);
    expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/?room=${ROOM_ID}`);
  });
});
