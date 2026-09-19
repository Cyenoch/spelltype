import { For, Show, createMemo } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { Player } from '../../../../shared/protocol';
import { OPPONENT_KIND_LABELS } from '../../../ui/format';
import { ASSETS, avatarFallbackForSlot, avatarForSlot } from '../../../pixi/assets';
import { styles } from './lobby-panel.styles';

interface SeatBadge {
  label: string;
  tone: 'host' | 'ready' | 'not-ready' | 'offline' | 'synthetic';
  testid: string;
}

const BADGE_TONE = {
  host: 'badgeHost',
  ready: 'badgeReady',
  'not-ready': 'badgeOffline',
  offline: 'badgeOffline',
  synthetic: 'badgeSynthetic',
} as const;

/** 席位展示的徽章列表，按大厅一贯的顺序排列。 */
function seatBadges(player: Player, hostId: string): SeatBadge[] {
  const badges: SeatBadge[] = [];
  // 非真人对手首先表明自身类型：绝不伪装成离线或隐身的人类玩家。
  if (player.kind !== 'human')
    badges.push({
      label: OPPONENT_KIND_LABELS[player.kind],
      tone: 'synthetic',
      testid: 'lobby-badge-kind',
    });
  if (player.id === hostId)
    badges.push({ label: '房主', tone: 'host', testid: 'lobby-badge-host' });
  badges.push(
    player.ready
      ? { label: '已准备', tone: 'ready', testid: 'lobby-badge-ready' }
      : { label: '未准备', tone: 'not-ready', testid: 'lobby-badge-not-ready' },
  );
  if (player.kind === 'human' && !player.connected)
    badges.push({ label: '离线', tone: 'offline', testid: 'lobby-badge-offline' });
  return badges;
}

/**
 * 决斗舞台上的单个席位。自身席位及独占对手席位采用大型圆形头像；
 * 额外的对手与开放的邀请席位则展示为紧凑的单行卡片，确保 3 个席位也不会超出舞台尺寸。
 * 快速匹配模式下的空席位保留匹配队列中的面纱对手头像——扫描动画表达“对手正在路上”——
 * 而私密房间的空席位则纯粹作为等待好友邀请的空位。
 */
export function Seat(props: {
  slot: number;
  hidden?: boolean;
  player: Player | undefined;
  selfId: string;
  hostId: string;
  /** 带小头像的单行卡片：用于多出的对手及开放的邀请席位。 */
  compact?: boolean;
  /** 预留的对手尚未进入的快速匹配席位。 */
  searching?: boolean;
  /** 空席位展示的名称：对手正在连接时显示为 `未知`。 */
  emptyLabel: string;
  /** 提示玩家针对空席位下一步该执行的操作文案。 */
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
          props.player &&
            props.player.kind === 'human' &&
            !props.player.connected &&
            styles.cardOffline,
        ).className
      }
      data-testid="lobby-slot"
      data-slot={props.slot}
      data-user={props.player?.id ?? ''}
      data-kind={props.player?.kind ?? ''}
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
            ? props.player.kind !== 'human'
              ? `席位 ${props.slot + 1} · 训练对手，随开随战`
              : props.player.connected
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
