import { For, createMemo } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { Player } from '../../../../shared/protocol';
import { avatarFallbackForSlot, avatarForSlot } from '../../../pixi/assets';
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

/** One seat: taken by a player, or an invitation to fill it. */
export function Seat(props: {
  slot: number;
  hidden: boolean;
  player: Player | undefined;
  selfId: string;
  hostId: string;
}) {
  const isSelf = createMemo(() => props.player?.id === props.selfId);
  const badges = createMemo(() => (props.player ? seatBadges(props.player, props.hostId) : []));

  return (
    <div
      class={
        stylex.props(
          styles.seat,
          !props.player && styles.seatEmpty,
          isSelf() && styles.seatSelf,
          props.player && !props.player.connected && styles.seatOffline,
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
      role="listitem"
    >
      <img
        class={stylex.props(styles.seatAvatar).className}
        src={avatarForSlot(props.slot)}
        alt={props.player ? `${props.player.username} 的头像` : ''}
        decoding="async"
        onError={(event) => {
          const image = event.currentTarget;
          if (image.dataset.fallbackApplied) return;
          image.dataset.fallbackApplied = '1';
          image.src = avatarFallbackForSlot(props.slot);
        }}
      />
      <div class={stylex.props(styles.seatBody).className}>
        <div class={stylex.props(styles.seatName).className} data-testid="lobby-slot-name">
          {props.player ? `${props.player.username}${isSelf() ? '（你）' : ''}` : '空席位'}
        </div>
        <div class={stylex.props(styles.seatMeta).className} data-testid="lobby-slot-meta">
          {props.player
            ? props.player.connected
              ? `席位 ${props.slot + 1} · 已连接`
              : `席位 ${props.slot + 1} · 连接中断`
            : '把邀请链接发给朋友'}
        </div>
        <div class={stylex.props(styles.seatBadges).className} data-testid="lobby-slot-badges">
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
