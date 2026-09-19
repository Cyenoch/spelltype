import { For, Show, createMemo, createSignal } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import {
  OPENING_COUNTDOWN_MS,
  SPELL_BOOK_SIZE,
  type RoomSnapshot,
} from '../../../../shared/protocol';
import { ASSETS, arenaFor } from '../../../pixi/assets';
import { ELEMENTS, isPresetTheme } from '../../../ui/format';
import { ui } from '../../../ui/primitives';
import { arenaIndex } from './battle-view';
import { styles } from './battle-generation.styles';

const SLOTS = [0, 1, 2, 3] as const;

const SLOT_ROTATION = [null, styles.slotB, styles.slotC, styles.slotD];
const GLYPH_UPRIGHT = [null, styles.uprightB, styles.uprightC, styles.uprightD];

/**
 * 权威 `generating` 阶段专用的咒文生成场景：
 * 旋转符文环中悬浮的一本魔导书，周围环绕对局的真实现状。
 * 它存在的意义是让该阶段绝不会被误认为卡死的空白战斗界面 ——
 * 常规战斗界面全程保持挂载，只是被隐藏，
 * 因此每个画布与输入宿主都能存活到倒计时接管。
 *
 * 这里每一句状态文字都来自快照：谁已准备、本房间在等待什么 ——
 * 预设主题按主题共享同一本缓存咒文书（新鲜期内近乎瞬时返回，
 * 旧书过期时需等待一次新书生成，与之同时开局的房间仍沿用旧咒文），
 * 自定义主题则按对局生成 —— 书中始终包含 `SPELL_BOOK_SIZE` 条英文咒文及其中文释义，
 * 且一旦书就绪，`OPENING_COUNTDOWN_MS` 倒计时会自行开始。
 * 此处不统计咒文数、百分比或子阶段，因为房间并不公布这类进度。
 */
export function BattleGeneration(props: {
  snapshot: RoomSnapshot;
  /** 战斗界面展示的唯一失败提示行，或 null。 */
  notice: string | null;
  onLeave(): void;
}) {
  const [paused, setPaused] = createSignal(false);
  const [backdropFailed, setBackdropFailed] = createSignal(false);
  const hold = () => (paused() ? styles.paused : null);

  // 能进入该阶段，即证明匹配/准备流程已经完成。
  const readyLabel = createMemo(() =>
    props.snapshot.mode === 'quick' ? '匹配成功' : '玩家准备完成',
  );

  const stateText = createMemo(() => {
    const sharing = isPresetTheme(props.snapshot.theme)
      ? '正在获取本主题的共享咒文书。需要生成新书时，本局等待就绪；已有旧书的其他对局可直接开战。'
      : '自定义主题不使用缓存，正在为本局单独生成咒文。';
    return (
      `${readyLabel()}。${sharing}咒文书共 ${SPELL_BOOK_SIZE} 条英文咒文与对应中文释义，` +
      `就绪后自动开始 ${OPENING_COUNTDOWN_MS / 1000} 秒倒数。`
    );
  });

  return (
    <div
      class={stylex.props(styles.scene).className}
      data-testid="spell-generation"
      data-motion={paused() ? 'paused' : 'full'}
      aria-busy="true"
      aria-labelledby="spell-generation-title"
    >
      <img
        class={stylex.props(styles.backdrop).className}
        src={arenaFor(arenaIndex(props.snapshot.id))}
        alt=""
        aria-hidden="true"
        decoding="async"
        hidden={backdropFailed()}
        onError={() => setBackdropFailed(true)}
      />

      <div class={stylex.props(styles.dust).className} aria-hidden="true">
        <span class={stylex.props(styles.moteP, styles.p1, hold()).className} />
        <span class={stylex.props(styles.moteP, styles.p2, hold()).className} />
        <span class={stylex.props(styles.moteP, styles.p3, hold()).className} />
        <span class={stylex.props(styles.moteP, styles.p4, hold()).className} />
        <span class={stylex.props(styles.moteP, styles.p5, hold()).className} />
      </div>

      <div class={stylex.props(styles.inner).className}>
        <h2 id="spell-generation-title" class={stylex.props(styles.title).className}>
          正在准备咒文书…
        </h2>

        <div class={stylex.props(styles.stage).className} aria-hidden="true">
          <img
            class={stylex.props(styles.aura, styles.auraRun, hold()).className}
            src={ASSETS.spark}
            alt=""
            width="240"
            height="240"
            decoding="async"
          />
          <span
            class={
              stylex.props(styles.ring, styles.ringBase, styles.ringPulseRun, hold()).className
            }
          />
          <span
            class={
              stylex.props(styles.ring, styles.ringSweep, styles.ringSweepRun, hold()).className
            }
          />
          <span class={stylex.props(styles.ring, styles.ringInner).className} />

          <div class={stylex.props(styles.orbit, styles.orbitRun, hold()).className}>
            <For each={SLOTS}>
              {(slot) => (
                <span class={stylex.props(styles.glyphSlot, SLOT_ROTATION[slot]).className}>
                  <span
                    class={
                      stylex.props(styles.glyphCounter, styles.glyphCounterRun, hold()).className
                    }
                  >
                    <img
                      class={stylex.props(styles.glyphImg, GLYPH_UPRIGHT[slot]).className}
                      src={ASSETS.elementGlyphs[ELEMENTS[slot]]}
                      alt=""
                      width="22"
                      height="22"
                      decoding="async"
                    />
                  </span>
                </span>
              )}
            </For>
          </div>

          <div class={stylex.props(styles.orbit, styles.orbitRevRun, hold()).className}>
            <span class={stylex.props(styles.orbitDot, styles.dotRun, hold()).className} />
            <span
              class={stylex.props(styles.orbitDot, styles.dotB, styles.dotRun, hold()).className}
            />
          </div>

          <div class={stylex.props(styles.book, styles.bookRun, hold()).className}>
            <span class={stylex.props(styles.bookPages).className} />
            <span
              class={
                stylex.props(styles.bookCover, styles.bookSheen, styles.bookSheenRun, hold())
                  .className
              }
            >
              <img
                class={stylex.props(styles.bookEmblem, styles.emblemRun, hold()).className}
                src={ASSETS.sigil}
                alt=""
                width="72"
                height="72"
                decoding="async"
              />
            </span>
            <span class={stylex.props(styles.bookShadow, styles.shadowRun, hold()).className} />
          </div>
        </div>

        <p
          class={stylex.props(styles.state).className}
          role="status"
          aria-live="polite"
          data-testid="generation-state"
        >
          {stateText()}
        </p>

        <ol class={stylex.props(styles.trail).className} data-testid="generation-trail">
          <li
            class={stylex.props(styles.step, styles.stepDone).className}
            data-testid="generation-step-ready"
            data-step="done"
          >
            <span
              class={stylex.props(styles.marker, styles.markerDone).className}
              aria-hidden="true"
            >
              ✓
            </span>
            {readyLabel()}
          </li>
          <li
            class={stylex.props(styles.step, styles.stepCurrent).className}
            data-testid="generation-step-cast"
            data-step="current"
            aria-current="step"
          >
            <span
              class={stylex.props(styles.marker, styles.markerCurrent).className}
              aria-hidden="true"
            >
              ●
            </span>
            准备咒文书
          </li>
          <li
            class={stylex.props(styles.step).className}
            data-testid="generation-step-countdown"
            data-step="pending"
          >
            <span class={stylex.props(styles.marker).className} aria-hidden="true">
              ○
            </span>
            {OPENING_COUNTDOWN_MS / 1000} 秒倒数开战
          </li>
        </ol>

        <Show when={props.snapshot.theme}>
          {(theme) => (
            <p class={stylex.props(styles.theme).className} data-testid="generation-theme">
              主题「{theme()}」
            </p>
          )}
        </Show>

        <Show when={props.notice}>
          {(message) => (
            <div
              class={stylex.props(ui.notice, styles.genNotice).className}
              data-tone="warn"
              data-testid="generation-notice"
            >
              <span class={stylex.props(ui.noticeIcon).className} aria-hidden="true">
                ⚠
              </span>
              <div>{message()}</div>
            </div>
          )}
        </Show>

        <div class={stylex.props(ui.buttonRow, styles.actionsRow).className}>
          <button
            type="button"
            class={stylex.props(ui.button, ui.small, ui.ghost, styles.motionToggle).className}
            data-testid="generation-motion"
            aria-pressed={paused()}
            onClick={() => setPaused((value) => !value)}
          >
            {paused() ? '开启动效' : '暂停动效'}
          </button>
          <button
            type="button"
            class={stylex.props(ui.button, ui.small, ui.danger, ui.quiet).className}
            data-testid="generation-leave"
            onClick={() => props.onLeave()}
          >
            离开房间
          </button>
        </div>
      </div>
    </div>
  );
}
