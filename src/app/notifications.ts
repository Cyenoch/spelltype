/**
 * 对局事件提醒服务：每个应用一份实例，归会话所有。
 *
 * 此处关键的边界约束：
 * - 仅作为页面运行时的辅助提醒。只有在用户开启了自身开关、
 *   已授予浏览器通知权限且当前页面处于隐藏状态时才会展示提醒；
 *   页面可见时已经展示了通知中应包含的所有内容。
 * - 此处绝不与任何推送服务交互：无 PushManager、无推送订阅，亦无服务端推送接口。
 *   Service Worker 存在的唯一目的，是为 `showNotification` 提供注册上下文，
 *   并使用户点击通知时能准确定位回对应的窗口。
 * - 每个真实事件只触发一次提醒。每次异步流转（Service Worker 注册、跨标签页锁、
 *   实际展示调用等）均会重新校验捕获的生成纪元（generation），
 *   中途失效的提醒要么被中止，要么被关闭——绝不在对局状态已改变后延迟送达。
 */
import { createEffect, createSignal, on, onMount } from 'solid-js';
import type { Session } from './session';

export type GameNotificationKind = 'matched' | 'countdown' | 'generation-failed' | 'finished';

/** 值得发送提醒的真实对局事件。`expiresAt` 限定了尝试送达的有效时间。 */
export interface GameNotification {
  kind: GameNotificationKind;
  roomId: string;
  matchId: string | null;
  expiresAt: number;
}

export interface NotificationService {
  /** 用户自身的开关状态，按账户持久化保存。独立于浏览器权限。 */
  enabled(): boolean;
  /** `'unsupported'` 涵盖功能缺失、不安全上下文以及注册失败等情况。 */
  permission(): NotificationPermission | 'unsupported';
  /** 必须直接在点击事件处理函数中调用：权限请求必须先于所有 await 语句执行。 */
  enable(): Promise<void>;
  disable(): void;
  /** 契约上属于触发即忘（Fire-and-forget）：调用方绝不需要 await 此方法，也绝不需要对其分支判断。 */
  notify(event: GameNotification): Promise<void>;
  /** 取消指定房间所有待处理的提醒尝试，并关闭已展示的提醒。 */
  invalidateRoom(roomId: string): void;
}

/** 固定的说明文案；真实告知页面端提醒的功能边界。 */
export const NOTIFICATION_LIMITS =
  '仅在此页面保持运行并收到状态更新时提醒；关闭页面或系统冻结后台后，可能无法及时提醒。匹配席位仍按原时限保留。';

const COPY: Record<GameNotificationKind, { title: string; body: string }> = {
  matched: { title: '匹配成功', body: '对手已找到，点击返回房间。' },
  countdown: { title: '对局已就绪', body: '咒文已就绪，请返回对局。' },
  'generation-failed': { title: '出题未完成', body: '请返回房间查看结果并重试。' },
  finished: { title: '本局已结束', body: '点击查看本局结果。' },
};

const PREFERENCE_PREFIX = 'spelltype:notifications:';
const LEDGER_PREFIX = 'spelltype:notification-events:';
const LOCK_PREFIX = 'spelltype:notifications:';
const TAG_PREFIX = 'spelltype:';
/** 已匹配的入场券尚无 matchId；此时预约信息（reservation）作为去重标识。 */
const RESERVATION_KEY = 'reserved';
const LEDGER_LIMIT = 32;
const SW_URL = '/sw.js';

/** 测试运行时显式启用；普通开发服务器不启用 SW，生产环境始终注册 SW。 */
const swAllowed = (): boolean =>
  import.meta.env.PROD || import.meta.env.VITE_ENABLE_NOTIFICATIONS_SW === '1';

interface Attempt {
  key: string;
  roomId: string;
  gen: number;
  accountGen: number;
  ownerId: string;
  expiresAt: number;
}

function readLedger(userId: string): string[] {
  try {
    const raw = localStorage.getItem(`${LEDGER_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function loadPreference(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(`${PREFERENCE_PREFIX}${userId}`) === 'on';
  } catch {
    return false;
  }
}

function savePreference(userId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(`${PREFERENCE_PREFIX}${userId}`, 'on');
    else localStorage.removeItem(`${PREFERENCE_PREFIX}${userId}`);
  } catch {
    // 存储不可用时仅在当前页面内存中保留偏好设置；绝不导致程序崩溃。
  }
}

function writeLedger(userId: string, entries: string[]): void {
  try {
    localStorage.setItem(`${LEDGER_PREFIX}${userId}`, JSON.stringify(entries.slice(-LEDGER_LIMIT)));
  } catch {
    // 记录本丢失仅可能导致重复弹出 Toast，绝不会破坏对局状态。
  }
}

/** 创建应用的唯一通知服务实例。须在应用的组件上下文中调用。 */
export function createNotificationService(props: { session: Session }): NotificationService {
  const supported = (): boolean =>
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'Notification' in window &&
    typeof Notification.requestPermission === 'function';

  const [enabled, setEnabled] = createSignal(false);
  const [nativePermission, setNativePermission] = createSignal<NotificationPermission>(
    supported() ? Notification.permission : 'denied',
  );
  /** Service Worker 注册失败属于环境不可用，不应进入重试循环。 */
  const [broken, setBroken] = createSignal(false);

  /** 每当账户身份或授权偏好变更时递增；使所有进行中的尝试立即失效。 */
  let accountGeneration = 0;
  /** 按房间划分的事件纪元：更新的事件（或主动失效）会废弃旧的待处理事件。 */
  const rooms = new Map<string, { gen: number; lastKey: string | null }>();
  /** 页面级去重：本页面已送达（或已知其他标签页已送达）的事件 key。 */
  const shown = new Set<string>();

  let registration: Promise<ServiceWorkerRegistration> | null = null;

  const userId = (): string | null => props.session.user?.id ?? null;

  const permissionState = (): NotificationPermission | 'unsupported' => {
    if (!supported() || !swAllowed() || broken()) return 'unsupported';
    return nativePermission();
  };

  const startRegistration = (): Promise<ServiceWorkerRegistration | null> => {
    if (!registration) {
      registration = navigator.serviceWorker
        .register(SW_URL, { scope: '/', updateViaCache: 'none' })
        .catch((error: unknown) => {
          setBroken(true);
          throw error;
        });
    }
    return registration;
  };

  const currentRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!registration) return null;
    try {
      return await registration;
    } catch {
      return null;
    }
  };

  // 在挂载时立即执行注册，先于任何用户交互：enable() 绝不需要首先等待其完成。
  onMount(() => {
    if (supported() && swAllowed()) void startRegistration().catch(() => undefined);
  });

  const closeAccountNotifications = async (ownerId: string): Promise<void> => {
    const reg = await currentRegistration();
    if (!reg) return;
    const prefix = `${TAG_PREFIX}${ownerId}:`;
    for (const notification of await reg.getNotifications()) {
      if (typeof notification.tag === 'string' && notification.tag.startsWith(prefix)) {
        notification.close();
      }
    }
  };

  // 会话身份统领所有状态：账户变更或登出时，清空待处理尝试、
  // 页面去重集合，并为上一任所有者关闭所有已展示的提醒。
  createEffect(
    on(
      () => userId(),
      (id, previous) => {
        if (id === previous) return;
        accountGeneration += 1;
        rooms.clear();
        shown.clear();
        setEnabled(loadPreference(id));
        if (previous) void closeAccountNotifications(previous).catch(() => undefined);
      },
    ),
  );

  /** 在每次 await 之后重新校验：身份、代际、授权、可见性与有效期。 */
  const stillValid = (attempt: Attempt): boolean =>
    userId() === attempt.ownerId &&
    accountGeneration === attempt.accountGen &&
    rooms.get(attempt.roomId)?.gen === attempt.gen &&
    permissionState() === 'granted' &&
    document.visibilityState === 'hidden' &&
    Date.now() < attempt.expiresAt;

  const show = async (
    reg: ServiceWorkerRegistration,
    attempt: Attempt,
    event: GameNotification,
  ): Promise<void> => {
    const copy = COPY[event.kind];
    // `renotify` 已在浏览器中提供，但本 TypeScript DOM 类型库尚未包含它。
    const options: NotificationOptions & { renotify?: boolean } = {
      body: copy.body,
      lang: 'zh-CN',
      tag: `${TAG_PREFIX}${attempt.ownerId}:${attempt.roomId}`,
      renotify: false,
      data: {
        roomId: attempt.roomId,
        eventKey: attempt.key,
        gen: attempt.gen,
        expiresAt: attempt.expiresAt,
      },
    };
    await reg.showNotification(copy.title, options);
  };

  /** 只关闭本次尝试所产生的通知；绝不关闭同一房间更新的那条。 */
  const closeShown = async (reg: ServiceWorkerRegistration, attempt: Attempt): Promise<void> => {
    try {
      const tag = `${TAG_PREFIX}${attempt.ownerId}:${attempt.roomId}`;
      for (const notification of await reg.getNotifications()) {
        if (notification.tag !== tag) continue;
        const data = notification.data as { eventKey?: string; gen?: number } | null;
        if (data?.eventKey === attempt.key && data?.gen === attempt.gen) notification.close();
      }
    } catch {
      // 尽力而为的清理；相比错误关闭，一条陈旧的吐司提示无害得多。
    }
  };

  const notify = async (event: GameNotification): Promise<void> => {
    const ownerId = userId();
    if (!ownerId || !enabled() || permissionState() !== 'granted') return;
    if (!Number.isFinite(event.expiresAt) || Date.now() >= event.expiresAt) return;
    if (document.visibilityState !== 'hidden') return;

    const key = [ownerId, event.roomId, event.matchId ?? RESERVATION_KEY, event.kind].join(':');
    if (shown.has(key)) return;

    // 房间的新事件身份会取代该房间任何仍在飞行中的尝试。
    let room = rooms.get(event.roomId);
    if (!room) {
      room = { gen: 0, lastKey: null };
      rooms.set(event.roomId, room);
    }
    if (room.lastKey !== key) {
      room.gen += 1;
      room.lastKey = key;
    }
    const attempt: Attempt = {
      key,
      roomId: event.roomId,
      gen: room.gen,
      accountGen: accountGeneration,
      ownerId,
      expiresAt: event.expiresAt,
    };

    try {
      const reg = await startRegistration();
      if (!reg || !stillValid(attempt)) return;
      if (typeof navigator.locks?.request === 'function') {
        // 一把账号级的锁在跨标签页场景下串行化 读取 → 去重 → 展示 → 记录。
        await navigator.locks.request(`${LOCK_PREFIX}${attempt.ownerId}`, async () => {
          if (!stillValid(attempt)) return;
          const ledger = readLedger(attempt.ownerId);
          if (ledger.includes(attempt.key)) {
            shown.add(attempt.key);
            return;
          }
          await show(reg, attempt, event);
          if (!stillValid(attempt)) {
            await closeShown(reg, attempt);
            return;
          }
          writeLedger(attempt.ownerId, [...ledger, attempt.key]);
          shown.add(attempt.key);
        });
      } else {
        await show(reg, attempt, event);
        if (!stillValid(attempt)) {
          await closeShown(reg, attempt);
          return;
        }
        shown.add(attempt.key);
      }
    } catch {
      // 送达是尽力而为的：失败不会改变任何对局状态，也绝不自行重试。
    }
  };

  const invalidateRoom = (roomId: string): void => {
    const room = rooms.get(roomId);
    // 若没有本地房间状态（该提醒可能已由另一个标签页展示过），
    // 则房间的每条提醒都已陈旧；否则只针对已记录的代际。
    const staleUpTo = room?.gen ?? Number.POSITIVE_INFINITY;
    if (room) {
      room.gen += 1;
      room.lastKey = null;
    }
    const ownerId = userId();
    if (!ownerId) return;
    void (async () => {
      const reg = await currentRegistration();
      if (!reg) return;
      const tag = `${TAG_PREFIX}${ownerId}:${roomId}`;
      for (const notification of await reg.getNotifications()) {
        if (notification.tag !== tag) continue;
        const data = notification.data as { gen?: number } | null;
        const gen = typeof data?.gen === 'number' ? data.gen : Number.NEGATIVE_INFINITY;
        if (gen <= staleUpTo) notification.close();
      }
    })().catch(() => undefined);
  };

  const enable = async (): Promise<void> => {
    if (!supported()) return;
    try {
      // 在点击处理器的调用栈中运行：权限请求是最先发生的事，
      // 早于任何可能耗掉用户手势的 await。
      if (Notification.permission === 'default') {
        setNativePermission(await Notification.requestPermission());
      }
      setNativePermission(Notification.permission);
      if (Notification.permission !== 'granted') return;
      const reg = swAllowed() ? await startRegistration() : null;
      const ownerId = userId();
      if (!reg || !ownerId) return;
      savePreference(ownerId, true);
      setEnabled(true);
    } catch {
      setNativePermission(Notification.permission);
    }
  };

  const disable = (): void => {
    const ownerId = userId();
    setEnabled(false);
    accountGeneration += 1;
    rooms.clear();
    shown.clear();
    if (ownerId) {
      savePreference(ownerId, false);
      void closeAccountNotifications(ownerId).catch(() => undefined);
    }
  };

  return {
    enabled,
    permission: permissionState,
    enable: () => enable(),
    disable,
    notify,
    invalidateRoom,
  };
}
