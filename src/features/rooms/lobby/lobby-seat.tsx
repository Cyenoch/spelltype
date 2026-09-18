import { For, Show, createMemo } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { Player } from '../../../../shared/protocol';
import { ASSETS, avatarFallbackForSlot, avatarForSlot } from '../../../pixi/assets';
import { styles } from './lobby-panel.styles';

interface SeatBadge {
  label: string;
  tone: 'host' | 'ready' | 'not-ready' | 'offline';
  testid: string;
}

const BADGE_TONE = {
  host: 'badgeHost',
  ready: 'badgeReady',
  'not-ready': 'badgeOffline',
  offline: 'badgeOffline',
} as const;

/** The badges one seat shows, in the order the lobby has always shown them. */
function seatBadges(player: Player, hostId: string): SeatBadge[] {
  const badges: SeatBadge[] = [];
  if (player.id === hostId)
    badges.push({ label: '房主', tone: 'host', testid: 'lobby-badge-host' });
  badges.push(
    player.ready
      ? { label: '已准备', tone: 'ready', testid: 'lobby-badge-ready' }
      : { label: '未准备', tone: 'not-ready', testid: 'lobby-badge-not-ready' },
  );
  if (!player.connected)
    badges.push({ label: '离线', tone: 'offline', testid: 'lobby-badge-offline' });
  return badges;
}

/**
 * One seat on the duel stage. The self side and a lone rival get the large
 * round portrait; additional rivals and open invitation slots read as compact
 * row cards so three of them never outgrow the stage. An empty quick-match
 * slot keeps the queue's veiled rival — the scan says "the opponent is on the
 * way" — while an empty private slot is just an invitation.
 */
export function Seat(props: {
  slot: number;
  hidden?: boolean;
  player: Player | undefined;
  selfId: string;
  hostId: string;
  /** Row card with a small portrait: extra rivals and open invitation slots. */
  compact?: boolean;
  /** The quick-match slot whose reserved opponent has not arrived yet. */
  searching?: boolean;
  /** Name shown for an empty seat: `未知` while a rival is pending. */
  emptyLabel: string;
  /** What an empty seat should tell the viewer to do next. */
  emptyNote: string;
}) {
  const isSelf = createMemo(() => props.player?.id === props.selfId);
  const badges = createMemo(() => (props.player ? seatBadges(props.player, props.hostId) : []));
  const occupied = createMemo(() => Boolean(props.player));

  return (
    <div
      class={
        stylex.props(
          styles.card,
          props.compact && styles.cardCompact,
          props.player && !props.player.connected && styles.cardOffline,
        ).className
      }
      data-testid="lobby-slot"
      data-slot={props.slot}
      data-user={props.player?.id ?? ''}
      data-connected={props.player ? String(props.player.connected) : ''}
      data-ready={props.player ? String(props.player.ready) : ''}
      data-self={props.player ? String(isSelf()) : ''}
      data-host={props.player ? String(props.player.id === props.hostId) : ''}
      hidden={props.hidden}
    >
      <div
        class={
          stylex.props(
            styles.art,
            props.compact && styles.artCompact,
            isSelf() && styles.artSelf,
            occupied() && props.player!.ready && styles.artReady,
            !occupied() && styles.artEmpty,
          ).className
        }
      >
        <Show
          when={props.player}
          fallback={
            <>
              <Show when={props.searching}>
                <img
                  class={stylex.props(styles.crestVeiled).className}
                  src={ASSETS.sigil}
                  alt=""
                  width="80"
                  height="80"
                  decoding="async"
                />
                <span class={stylex.props(styles.veil, styles.veilScan).className} />
              </Show>
              <span
                class={
                  stylex.props(styles.unknown, props.compact && styles.unknownCompact).className
                }
                aria-hidden="true"
              >
                ?
              </span>
            </>
          }
        >
          {(player) => (
            <img
              class={stylex.props(styles.avatar).className}
              src={avatarForSlot(props.slot)}
              alt={`${player().username} 的头像`}
              decoding="async"
              onError={(event) => {
                const image = event.currentTarget;
                if (image.dataset.fallbackApplied) return;
                image.dataset.fallbackApplied = '1';
                image.src = avatarFallbackForSlot(props.slot);
              }}
            />
          )}
        </Show>
      </div>
      <div class={stylex.props(styles.cardBody, props.compact && styles.cardBodyCompact).className}>
        <Show when={occupied() || props.searching}>
          <span class={stylex.props(styles.tag, isSelf() && styles.tagSelf).className}>
            {isSelf() ? '你' : '对手'}
          </span>
        </Show>
        <div
          class={
            stylex.props(
              styles.name,
              props.compact && styles.nameCompact,
              !occupied() && !props.compact && styles.nameUnknown,
            ).className
          }
          data-testid="lobby-slot-name"
        >
          {props.player ? `${props.player.username}${isSelf() ? '（你）' : ''}` : props.emptyLabel}
        </div>
        <div class={stylex.props(styles.note).className} data-testid="lobby-slot-meta">
          {props.player
            ? props.player.connected
              ? `席位 ${props.slot + 1} · 已连接`
              : `席位 ${props.slot + 1} · 连接中断`
            : props.emptyNote}
        </div>
        <div class={stylex.props(styles.badges).className} data-testid="lobby-slot-badges">
          <For each={badges()}>
            {(badge) => (
              <span
                class={stylex.props(styles.badge, styles[BADGE_TONE[badge.tone]]).className}
                data-testid={badge.testid}
              >
                {badge.label}
              </span>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
