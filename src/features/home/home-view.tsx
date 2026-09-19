import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import { Link, useNavigate } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { activityOptions } from '../../app/queries';
import { ELEMENTS } from '../../ui/format';
import { ASSETS } from '../../pixi/assets';
import { ui } from '../../ui/primitives';
import { styles } from './home.styles';
import { PlayerCard } from './home-player-card';
import { JoinRoom } from './home-join-room';
import { noticeStyles } from '../../ui/notice.styles';
import type { AppContext } from '../../app/context';

/** 每位玩家在首场对局前应当了解的四项关键数值。 */
export function MatchFacts() {
  return (
    <div class={stylex.props(styles.facts).className}>
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
        <span class={stylex.props(styles.factLabel).className}>每字总伤害</span>
      </div>
      <div class={stylex.props(styles.fact).className}>
        <b class={stylex.props(styles.factValue).className}>24 条</b>
        <span class={stylex.props(styles.factLabel).className}>共享咒文</span>
      </div>
    </div>
  );
}

/**
 * 实时活动数据，面向访客和已登录玩家公开：由服务端自身状态返回的两项计数指标。
 * 加载中与失败状态均按实际情况展示——绝不显示为 0——刷新失败时保持旧数据可见，
 * 并通过错误提示告知当前数据已过时。
 */
export function ActivityPanel() {
  const activity = useQuery(() => activityOptions);
  /** 尚未获得数据时保持显式占位符：加载中显示为 `…`，不可用时显示为 `—`。 */
  const counter = (count: number | undefined) =>
    activity.isPending ? '…' : count === undefined ? '—' : String(count);
  return (
    <section
      class={stylex.props(ui.panel, styles.activity).className}
      data-testid="home-activity"
      // `stale`：保留展示上一次获取的数值，并通过错误文案告知本次刷新失败。
      data-state={
        activity.isPending
          ? 'loading'
          : activity.error
            ? activity.data
              ? 'stale'
              : 'error'
            : 'ready'
      }
    >
      <div class={stylex.props(ui.panelHead, styles.activityHead).className}>
        <h2 class={stylex.props(ui.title, styles.h2Size).className}>实时活动</h2>
        <span class={stylex.props(ui.eyebrow).className}>每 10 秒刷新</span>
      </div>
      <div class={stylex.props(styles.facts).className}>
        <div class={stylex.props(styles.fact).className} data-testid="home-activity-duels">
          <b class={stylex.props(styles.factValue).className}>
            {counter(activity.data?.activeDuels)}
          </b>
          <span class={stylex.props(styles.factLabel).className}>正在进行的对决</span>
        </div>
        <div class={stylex.props(styles.fact).className} data-testid="home-activity-waiting">
          <b class={stylex.props(styles.factValue).className}>
            {counter(activity.data?.waitingPlayers)}
          </b>
          <span class={stylex.props(styles.factLabel).className}>正在等待匹配的玩家</span>
        </div>
      </div>
      <Show when={activity.isPending}>
        <p
          class={stylex.props(styles.activityNote).className}
          data-testid="home-activity-loading"
          role="status"
        >
          正在获取活动数据…
        </p>
      </Show>
      <Show when={activity.error}>
        <p
          class={stylex.props(styles.activityNote, styles.activityNoteError).className}
          data-testid="home-activity-error"
          role="status"
        >
          活动数据暂时无法获取，稍后自动重试。
        </p>
      </Show>
    </section>
  );
}

/** 游戏主入口：对局控制、账户概览及简短入门指南。 */
export function HomeView(props: { ctx: AppContext }) {
  const navigate = useNavigate();

  const maintenance = props.ctx.maintenance;
  const blocked = () => maintenance.admissionBlocked();
  const user = () => props.ctx.session.user;

  const requireAuth = (action: () => void) => {
    if (!props.ctx.session.user) {
      void navigate({
        to: '/auth',
        search: { room: props.ctx.pendingInvite() ?? undefined },
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

            {/* 保持挂载状态，确保在隐藏时仍可被测试观察可用性。 */}
            <div
              class={stylex.props(ui.notice, noticeStyles.warn, styles.heroNotice).className}
              data-testid="home-service-notice"
              data-tone="warn"
              data-state={maintenance.draining() ? 'draining' : 'unavailable'}
              hidden={!blocked()}
            >
              <Show when={blocked()}>
                {maintenance.draining()
                  ? '系统维护中：暂时无法开始新的对局，正在进行的对局不受影响；维护结束后即可重新匹配。'
                  : '暂时无法获取服务状态：已暂停开始新的对局，恢复后即可正常匹配。'}
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
                <p class={stylex.props(styles.entryNote).className}>
                  直接进入队列，与另一位玩家一起对决。
                </p>
                <div class={stylex.props(styles.entrySeats).className} aria-hidden="true">
                  <img
                    class={stylex.props(styles.seatImg).className}
                    src={ASSETS.avatars[0]}
                    alt=""
                    width="28"
                    height="28"
                  />
                  <span class={stylex.props(styles.duelMark).className}>VS</span>
                  <img
                    class={stylex.props(styles.seatImg).className}
                    src={ASSETS.avatars[1]}
                    alt=""
                    width="28"
                    height="28"
                  />
                </div>
                <button
                  class={stylex.props(ui.button, ui.primary, styles.entryButton).className}
                  type="button"
                  data-testid="home-quick-start"
                  disabled={blocked()}
                  onClick={() => requireAuth(() => void navigate({ to: '/match' }))}
                >
                  快速匹配 · 1v1
                </button>
              </div>

              <div class={stylex.props(styles.entry).className}>
                <div class={stylex.props(styles.entryHead).className}>
                  <h2 class={stylex.props(ui.title, styles.entryTitle).className}>私人房</h2>
                  <JoinRoom ctx={props.ctx} />
                </div>
                <p class={stylex.props(styles.entryNote).className}>
                  选一个咒文主题，把邀请码发给朋友一起打。
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
                  class={stylex.props(ui.button, styles.entryButton).className}
                  type="button"
                  data-testid="home-create"
                  disabled={blocked()}
                  onClick={() => requireAuth(() => void navigate({ to: '/create', search: {} }))}
                >
                  创建私人房 · 2–4 人
                </button>
              </div>
            </div>
          </div>

          <PlayerCard ctx={props.ctx} />
          <div class={stylex.props(styles.heroFacts).className}>
            <MatchFacts />
          </div>
        </div>
      </div>

      <ActivityPanel />

      <section class={stylex.props(ui.panel, styles.tutorial).className}>
        <div class={stylex.props(ui.panelHead, styles.tutorialHead).className}>
          <h2 class={stylex.props(ui.title, styles.h2Size).className}>三步上手</h2>
          <span class={stylex.props(ui.eyebrow).className}>1 分钟</span>
        </div>
        <ol class={stylex.props(styles.tutorialSteps).className}>
          <li class={stylex.props(styles.tutorialStep).className}>
            登录后快速匹配，或创建私人房把邀请码发给朋友。
          </li>
          <li class={stylex.props(styles.tutorialStep).className}>
            快速匹配自动开战；私人房准备就绪后，由房主开始。
          </li>
          <li class={stylex.props(styles.tutorialStep).className}>
            打完一条咒文，总伤害平均分给场上所有还活着的对手——一次施法，同时命中所有人。
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
