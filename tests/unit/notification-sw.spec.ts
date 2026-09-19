/**
 * Service Worker 的通知点击路由，直接基于发布的 `public/sw.js` 源码运行测试。
 * 这是无头浏览器无法测试的一处提醒逻辑（无头环境无法触发系统级 Toast 点击），
 * 因此其契约在此固化：同房间窗口优先并聚焦 —— 绝不重复导航跳转 —— 当不存在同房间窗口时打开邀请链接，
 * 且任何过期、格式异常或伪造的数据一律回退收拢至域名根路径。匹配器必须包含未受控窗口，
 * 否则首次注册将永远找不到注册它的页面。
 */
import { describe, expect, it, mock, type Mock } from 'bun:test';
import { runInNewContext } from 'node:vm';

const ORIGIN = 'https://spelltype.test';
const ROOM_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

const SW_SOURCE = await Bun.file(new URL('../../public/sw.js', import.meta.url)).text();

/** 模拟的 SW 客户端窗口：包含 URL 和 focus 监听 spy。 */
interface FakeWindow {
  url: string;
  focus: Mock<() => Promise<void>>;
}

/** `clients.matchAll` / `clients.openWindow` 的 spy 函数形态。 */
type ClientSpy = Mock<(...args: unknown[]) => Promise<unknown>>;

interface SwHarness {
  dispatchClick: (data: unknown) => Promise<void>;
  matchAll: ClientSpy;
  openWindow: ClientSpy;
}

/** 针对每个用例以全新 client stub 执行一次 worker 源码。 */
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
  it('聚焦同房间窗口，绝不打开新窗口或跳转导航至其它地址', async () => {
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

  it('查找未受控窗口：matchAll 必须包含它们', async () => {
    const worker = loadWorker([fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`)]);
    await worker.dispatchClick(reminder());
    expect(worker.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
  });

  it('当不存在同房间窗口时打开邀请 URL', async () => {
    const worker = loadWorker([fakeWindow(`${ORIGIN}/`), fakeWindow(`${ORIGIN}/?mode=login`)]);
    await worker.dispatchClick(reminder());
    expect(worker.openWindow).toHaveBeenCalledTimes(1);
    expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/?room=${ROOM_ID}`);
  });

  it('过期的提醒重定向至域名根路径，忽略同房间窗口', async () => {
    const room = fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`);
    const worker = loadWorker([room]);
    await worker.dispatchClick(reminder({ expiresAt: Date.now() - 1 }));
    expect(room.focus).not.toHaveBeenCalled();
    expect(worker.openWindow).toHaveBeenCalledTimes(1);
    expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/`);
  });

  it('伪造或格式错误的房间数据重定向至域名根路径', async () => {
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

  it('当同房间窗口拒绝聚焦时仍打开根路径', async () => {
    const room = fakeWindow(`${ORIGIN}/?room=${ROOM_ID}`);
    room.focus.mockRejectedValueOnce(new Error('not focused'));
    const worker = loadWorker([room]);
    await worker.dispatchClick(reminder());
    expect(worker.openWindow).toHaveBeenCalledTimes(1);
    expect(worker.openWindow.mock.calls[0][0]).toBe(`${ORIGIN}/?room=${ROOM_ID}`);
  });
});
