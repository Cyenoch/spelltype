import * as stylex from '@stylexjs/stylex';
import { createMemo } from 'solid-js';
import { QUICK_GHOST_FALLBACK_MS } from '../../../shared/protocol';
import { ASSETS } from '../../pixi/assets';
import { styles } from './queue-view.styles';
import type { QueueState } from './queue-controller';

const SELF_NOTES: Record<QueueState, string> = {
  waiting: '等待对手',
  matched: '已配对',
  cancelled: '已退出排队',
  blocked: '未加入排队',
  maintenance: '维护中',
};

const RIVAL_NOTES: Record<QueueState, string> = {
  waiting: `超过 ${QUICK_GHOST_FALLBACK_MS / 1000} 秒自动安排训练对手`,
  matched: '已配对',
  cancelled: '本次匹配已结束',
  blocked: '本次匹配未开始',
  maintenance: '本次匹配未开始',
};

/** 装饰性匹配舞台；系统减少动态效果偏好时会禁用动画。 */
export function QueueStage(props: { state: QueueState; username: string; retry: boolean }) {
  const searching = createMemo(() => props.state === 'waiting');
  const settled = createMemo(
    () => props.state === 'cancelled' || props.state === 'blocked' || props.state === 'maintenance',
  );

  return (
    <div
      data-testid="queue-stage"
      class={
        stylex.props(styles.stage, styles.stageRing, searching() && styles.stageSheen).className
      }
    >
      <div
        class={stylex.props(styles.duelist, styles.duelistSelf).className}
        data-testid="queue-self"
      >
        <div class={stylex.props(styles.art, styles.selfArt).className}>
          <img
            class={stylex.props(styles.crest, styles.selfCrest).className}
            src={ASSETS.avatars[0]}
            alt=""
            width="130"
            height="130"
            decoding="async"
          />
        </div>
        <div class={stylex.props(styles.duelistBody).className}>
          <span class={stylex.props(styles.tag, styles.selfTag).className}>你</span>
          <span class={stylex.props(styles.name).className} data-testid="queue-self-name">
            {props.username}
          </span>
          <span class={stylex.props(styles.note).className}>{SELF_NOTES[props.state]}</span>
        </div>
      </div>

      <div
        class={
          stylex.props(
            styles.sigil,
            settled() && styles.sigilSettled,
            props.state === 'matched' && styles.sigilMatched,
          ).className
        }
        aria-hidden="true"
      >
        <img
          class={stylex.props(styles.spark, searching() && styles.sparkRun).className}
          src={ASSETS.spark}
          alt=""
          width="240"
          height="240"
          decoding="async"
        />
        <span
          class={
            stylex.props(styles.ring, styles.ringPulse, searching() && styles.ringPulseRun)
              .className
          }
        />
        <span
          class={
            stylex.props(
              styles.ring,
              styles.ringSweep,
              props.retry && searching() && styles.ringSweepRetry,
              searching() && styles.ringSweepRun,
            ).className
          }
        />
        <div class={stylex.props(styles.orbit, searching() && styles.orbitRun).className}>
          <span class={stylex.props(styles.ring, styles.ringInner).className} />
          <span class={stylex.props(styles.mote, searching() && styles.moteRun).className} />
          <span
            class={stylex.props(styles.mote, styles.moteB, searching() && styles.moteRun).className}
          />
          <span
            class={stylex.props(styles.mote, styles.moteC, searching() && styles.moteRun).className}
          />
        </div>
        <img
          class={stylex.props(styles.core, searching() && styles.coreRun).className}
          src={ASSETS.sigil}
          alt=""
          width="80"
          height="80"
          decoding="async"
        />
      </div>

      <div
        class={
          stylex.props(styles.duelist, styles.duelistRival, settled() && styles.duelistRivalSettled)
            .className
        }
        data-testid="queue-opponent"
      >
        <div class={stylex.props(styles.art, styles.rivalArt).className}>
          <img
            class={stylex.props(styles.crest, styles.rivalCrest).className}
            src={ASSETS.sigil}
            alt=""
            width="80"
            height="80"
            decoding="async"
          />
          <span class={stylex.props(styles.veil, searching() && styles.veilScan).className} />
          <span class={stylex.props(styles.unknown).className} aria-hidden="true">
            ?
          </span>
        </div>
        <div class={stylex.props(styles.duelistBody).className}>
          <span class={stylex.props(styles.tag).className}>对手</span>
          <span class={stylex.props(styles.name, styles.nameUnknown).className}>未知</span>
          <span class={stylex.props(styles.note).className}>{RIVAL_NOTES[props.state]}</span>
        </div>
      </div>
    </div>
  );
}
