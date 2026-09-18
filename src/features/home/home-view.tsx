import { For, Show, createSignal } from 'solid-js';
import { Link, useNavigate } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { DIFFICULTIES, DIFFICULTY_HINTS, DIFFICULTY_LABELS, ELEMENTS } from '../../ui/format';
import { ASSETS } from '../../pixi/assets';
import { ui } from '../../ui/primitives';
import { styles } from './home.styles';
import { PlayerCard } from './home-player-card';
import { noticeStyles } from '../../ui/notice.styles';
import type { AppContext } from '../../app/context';
import type { Difficulty } from '../../../shared/protocol';

/** Which mode the quick-match card opens with. */
const DEFAULT_DIFFICULTY: Difficulty = 'normal';

/** The four numbers every player should know before their first match. */
export function MatchFacts(props: { spaced?: boolean }) {
  return (
    <div class={stylex.props(styles.facts, props.spaced && styles.factsSpaced).className}>
      <div class={stylex.props(styles.fact).className}>
        <b class={stylex.props(styles.factValue).className}>2400</b>
        <span class={stylex.props(styles.factLabel).className}>每人生命</span>
      </div>
      <div class={stylex.props(styles.fact).className}>
        <b class={stylex.props(styles.factValue).className}>240 秒</b>
        <span class={stylex.props(styles.factLabel).className}>单局时长</span>
      </div>
      <div class={stylex.props(styles.fact).className}>
        <b class={stylex.props(styles.factValue).className}>×4</b>
        <span class={stylex.props(styles.factLabel).className}>每字伤害</span>
      </div>
      <div class={stylex.props(styles.fact).className}>
        <b class={stylex.props(styles.factValue).className}>24 条</b>
        <span class={stylex.props(styles.factLabel).className}>共享咒文</span>
      </div>
    </div>
  );
}

/** The game entrance: match controls, account summary and a short primer. */
export function HomeView(props: { ctx: AppContext }) {
  const [difficulty, setDifficulty] = createSignal<Difficulty>(DEFAULT_DIFFICULTY);
  const navigate = useNavigate();

  const configured = () => props.ctx.session.aiConfigured;
  const user = () => props.ctx.session.user;

  const requireAuth = (action: () => void) => {
    if (!props.ctx.session.user) {
      void navigate({
        to: '/auth',
        search: { mode: 'login', room: props.ctx.pendingInvite() ?? undefined },
      });
      return;
    }
    action();
  };

  return (
    <section class={stylex.props(styles.page).className} data-testid="view-home">
      <div class={stylex.props(styles.hero).className}>
        <img
          class={stylex.props(styles.heroArt).className}
          src={ASSETS.arenas[0]}
          alt=""
          aria-hidden="true"
          decoding="async"
        />
        <div class={stylex.props(styles.heroLayout).className}>
          <div class={stylex.props(styles.heroMain).className}>
            <div class={stylex.props(styles.crest).className}>
              <img
                class={stylex.props(styles.crestImg).className}
                src={ASSETS.sigil}
                alt=""
                width="40"
                height="40"
              />
              <span class={stylex.props(styles.heroEyebrow).className}>连续咒文对决 · 2–4 人</span>
              <div class={stylex.props(styles.sigils).className} aria-hidden="true">
                <For each={ELEMENTS}>
                  {(element) => (
                    <img
                      class={stylex.props(styles.sigilImg).className}
                      src={ASSETS.elementGlyphs[element]}
                      alt=""
                      width="20"
                      height="20"
                    />
                  )}
                </For>
              </div>
            </div>

            <h1 class={stylex.props(ui.title, styles.heroTitle).className}>咒文对决</h1>
            <p class={stylex.props(styles.heroLead).className}>以文字为咒，以速度决胜。</p>
            <MatchFacts spaced />

            {/* Kept mounted so availability stays observable even while hidden. */}
            <div
              class={stylex.props(ui.notice, noticeStyles.warn, styles.heroNotice).className}
              data-testid="home-ai-notice"
              data-tone="warn"
              data-state={configured() ? 'configured' : 'missing'}
              hidden={configured()}
            >
              <Show when={!configured()}>
                咒文服务暂不可用。你仍可匹配或建房，请稍后再开始对决。
              </Show>
            </div>

            <Show when={props.ctx.pendingInvite()}>
              <div
                class={stylex.props(ui.notice, styles.heroNotice).className}
                data-testid="home-invite-notice"
                data-tone="info"
              >
                <span class={stylex.props(ui.noticeIcon).className}>✦</span>
                <div>
                  {user() ? '你收到了一份对战邀请。' : '你收到了一份对战邀请，登录后即可加入。'}
                  <div class={stylex.props(ui.buttonRow, noticeStyles.actions).className}>
                    <button
                      class={stylex.props(ui.button, ui.small, ui.gold).className}
                      type="button"
                      data-testid="home-join-invite"
                      onClick={() => {
                        const invite = props.ctx.pendingInvite();
                        if (!invite) return;
                        requireAuth(() => {
                          props.ctx.setPendingInvite(invite);
                          void navigate({ to: '/', search: { room: invite } });
                        });
                      }}
                    >
                      进入邀请的房间
                    </button>
                    <button
                      class={stylex.props(ui.button, ui.small, ui.ghost).className}
                      type="button"
                      data-testid="home-dismiss-invite"
                      onClick={() => {
                        props.ctx.setPendingInvite(null);
                        void navigate({ to: '/', search: {} });
                      }}
                    >
                      忽略邀请
                    </button>
                  </div>
                </div>
              </div>
            </Show>

            <div class={stylex.props(styles.entries).className}>
              <div class={stylex.props(styles.entry, styles.entryQuick).className}>
                <div class={stylex.props(styles.entryHead).className}>
                  <h2 class={stylex.props(ui.title, styles.entryTitle).className}>快速匹配</h2>
                  <span class={stylex.props(styles.entryTag).className}>1v1</span>
                </div>
                <label class={stylex.props(ui.label).className} for="home-difficulty">
                  咒文难度
                </label>
                <select
                  class={stylex.props(ui.input).className}
                  id="home-difficulty"
                  data-testid="home-quick-difficulty"
                  aria-describedby="quick-difficulty-hint"
                  data-difficulty={difficulty()}
                  onChange={(event) => setDifficulty(event.currentTarget.value as Difficulty)}
                >
                  <For each={DIFFICULTIES}>
                    {(level) => (
                      <option value={level} selected={level === DEFAULT_DIFFICULTY}>
                        {DIFFICULTY_LABELS[level]}
                      </option>
                    )}
                  </For>
                </select>
                <span class={stylex.props(ui.hint).className} id="quick-difficulty-hint">
                  {DIFFICULTY_HINTS[difficulty()]}
                </span>
                <button
                  class={stylex.props(ui.button, ui.primary, styles.entryButton).className}
                  type="button"
                  data-testid="home-quick-start"
                  onClick={() =>
                    requireAuth(
                      () => void navigate({ to: '/match', search: { difficulty: difficulty() } }),
                    )
                  }
                >
                  快速匹配 · 1v1
                </button>
              </div>

              <div class={stylex.props(styles.entry).className}>
                <h2 class={stylex.props(ui.title, styles.entryTitleRoom).className}>私人房</h2>
                <p class={stylex.props(styles.entryNote).className}>
                  选一个咒文主题，把邀请链接发给朋友一起打。
                </p>
                <div class={stylex.props(styles.entrySeats).className} aria-hidden="true">
                  <For each={ASSETS.avatars}>
                    {(avatar) => (
                      <img
                        class={stylex.props(styles.seatImg).className}
                        src={avatar}
                        alt=""
                        width="28"
                        height="28"
                        loading="lazy"
                      />
                    )}
                  </For>
                </div>
                <button
                  class={
                    stylex.props(ui.button, styles.entryButton, styles.entryButtonRoom).className
                  }
                  type="button"
                  data-testid="home-create"
                  onClick={() => requireAuth(() => void navigate({ to: '/create', search: {} }))}
                >
                  创建私人房 · 2–4 人
                </button>
              </div>
            </div>
          </div>

          <PlayerCard ctx={props.ctx} />
        </div>
      </div>

      <section class={stylex.props(ui.panel, styles.tutorial).className}>
        <div class={stylex.props(ui.panelHead, styles.tutorialHead).className}>
          <h2 class={stylex.props(ui.title, styles.h2Size).className}>三步上手</h2>
          <span class={stylex.props(ui.eyebrow).className}>1 分钟</span>
        </div>
        <ol class={stylex.props(styles.tutorialSteps).className}>
          <li class={stylex.props(styles.tutorialStep).className}>
            登录后快速匹配，或创建私人房把邀请链接发给朋友。
          </li>
          <li class={stylex.props(styles.tutorialStep).className}>
            快速匹配自动开战；私人房准备就绪后，由房主开始。
          </li>
          <li class={stylex.props(styles.tutorialStep).className}>
            打完一条咒文造成伤害，自动打向顺时针下一个还活着的人。
          </li>
        </ol>
        <Link
          class={stylex.props(styles.guideLink).className}
          data-testid="home-guide-link"
          to="/guide"
          search={{}}
        >
          <span>完整教程：从开局到结算</span>
          <span class={stylex.props(styles.guideArrow).className} aria-hidden="true">
            →
          </span>
        </Link>
      </section>
    </section>
  );
}
