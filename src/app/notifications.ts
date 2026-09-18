/**
 * The game-event notification service: one instance per application, owned by the
 * session.
 *
 * Boundaries that matter here:
 * - Delivery is a page-run courtesy. A notification is only shown while the user's
 *   own switch is on, the browser permission is granted and the page is hidden; a
 *   visible page already shows everything the notification would say.
 * - Nothing here ever talks to a push service: no PushManager, no subscription, no
 *   server endpoint. The service worker only exists so `showNotification` has a
 *   registration and so a tap can find the right window again.
 * - Reminders are one-shot per real event. Every asynchronous hand-off (service
 *   worker registration, the cross-tab lock, the display call itself) re-validates
 *   the captured generation, and anything invalidated mid-flight is either aborted
 *   or closed again — never delivered late into a changed game.
 */
import { createEffect, createSignal, on, onMount } from 'solid-js';
import type { Session } from './session';

export type GameNotificationKind = 'matched' | 'countdown' | 'generation-failed' | 'finished';

/** One real game event worth a reminder. `expiresAt` bounds the delivery attempt. */
export interface GameNotification {
  kind: GameNotificationKind;
  roomId: string;
  matchId: string | null;
  expiresAt: number;
}

export interface NotificationService {
  /** The user's own switch, persisted per account. Independent of browser permission. */
  enabled(): boolean;
  /** `'unsupported'` covers missing features, insecure contexts and a failed registration. */
  permission(): NotificationPermission | 'unsupported';
  /** Must be called directly from a click handler: the permission request precedes every await. */
  enable(): Promise<void>;
  disable(): void;
  /** Fire-and-forget by contract: callers never await this and never branch on it. */
  notify(event: GameNotification): Promise<void>;
  /** Cancels pending attempts for the room and closes its shown reminder. */
  invalidateRoom(roomId: string): void;
}

/** Fixed disclosure copy; the honest limits of page-run reminders. */
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
/** Matched tickets carry no match id yet; the reservation is the dedup identity. */
const RESERVATION_KEY = 'reserved';
const LEDGER_LIMIT = 32;
const SW_URL = '/sw.js';

/** Test runs opt in explicitly; a plain dev server stays SW-free, production always registers. */
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
    // A broken store keeps the preference in memory for this page only; never fatal.
  }
}

function writeLedger(userId: string, entries: string[]): void {
  try {
    localStorage.setItem(`${LEDGER_PREFIX}${userId}`, JSON.stringify(entries.slice(-LEDGER_LIMIT)));
  } catch {
    // Losing the ledger only risks a duplicate toast, never game state.
  }
}

/** Creates the one notification service for the application. Call inside the app's component scope. */
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
  /** A failed service worker registration is a broken environment, not a retry loop. */
  const [broken, setBroken] = createSignal(false);

  /** Bumped whenever the account identity or its consent changes; invalidates every attempt. */
  let accountGeneration = 0;
  /** Per-room event generation: a newer event (or an invalidation) kills older pending ones. */
  const rooms = new Map<string, { gen: number; lastKey: string | null }>();
  /** Page-level dedup: keys this page has already delivered (or knows another tab delivered). */
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

  // Registration happens on mount, before any gesture: enable() never waits on it first.
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

  // Session identity owns everything: a new or cleared account drops pending attempts,
  // the page dedup set, and — for the previous owner — every already-shown reminder.
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

  /** Re-checked after every await: identity, generation, consent, visibility and expiry. */
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
    // `renotify` ships in browsers but not yet in this TypeScript DOM lib.
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

  /** Closes only the notification this exact attempt produced; never a newer same-room one. */
  const closeShown = async (reg: ServiceWorkerRegistration, attempt: Attempt): Promise<void> => {
    try {
      const tag = `${TAG_PREFIX}${attempt.ownerId}:${attempt.roomId}`;
      for (const notification of await reg.getNotifications()) {
        if (notification.tag !== tag) continue;
        const data = notification.data as { eventKey?: string; gen?: number } | null;
        if (data?.eventKey === attempt.key && data?.gen === attempt.gen) notification.close();
      }
    } catch {
      // Best-effort cleanup; a stale toast is harmless compared to a wrong close.
    }
  };

  const notify = async (event: GameNotification): Promise<void> => {
    const ownerId = userId();
    if (!ownerId || !enabled() || permissionState() !== 'granted') return;
    if (!Number.isFinite(event.expiresAt) || Date.now() >= event.expiresAt) return;
    if (document.visibilityState !== 'hidden') return;

    const key = [ownerId, event.roomId, event.matchId ?? RESERVATION_KEY, event.kind].join(':');
    if (shown.has(key)) return;

    // A new event identity for a room supersedes any attempt still in flight for it.
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
        // One account-wide lock serialises read → dedup → show → record across tabs.
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
      // Delivery is best-effort: a failure changes no game state and never retries itself.
    }
  };

  const invalidateRoom = (roomId: string): void => {
    const room = rooms.get(roomId);
    // Without local room state (the reminder may have been shown by another tab),
    // every reminder for the room is stale; otherwise only the recorded generations.
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
      // Runs inside the click handler's stack: the permission request is the very
      // first thing that happens, before any await can spend the user gesture.
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
