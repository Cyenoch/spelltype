import { Link } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { ASSETS } from '../../pixi/assets';
import { ui } from '../../ui/primitives';
import { MatchFacts } from '../home/home-view';
import { styles } from '../home/home.styles';

/** Player-facing rules, separate from the compact homepage primer. */
export function GuideView() {
  return (
    <section class={stylex.props(styles.guide).className} data-testid="view-guide">
      <header class={stylex.props(styles.guideHead).className}>
        <div class={stylex.props(styles.guideHeadMain).className}>
          <span class={stylex.props(styles.heroEyebrow).className}>完整教程</span>
          <h1 class={stylex.props(ui.title, styles.guideTitle).className}>从第一秒到结算</h1>
          <p class={stylex.props(styles.guideLead).className}>
            一场咒文对决的全部规则：怎么开局、伤害怎么算、打字时会发生什么、打完怎么排名。
          </p>
          <MatchFacts />
        </div>
        <Link
          class={stylex.props(styles.guideBack).className}
          data-testid="guide-back"
          to="/"
          search={{}}
        >
          <span class={stylex.props(styles.backArrow).className} aria-hidden="true">
            ←
          </span>
          <span>返回首页</span>
        </Link>
      </header>

      <div class={stylex.props(styles.guideGrid).className}>
        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            开局：匹配还是私人房
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              快速匹配：直接寻找一名对手，双方进入房间即自动开始，无需点准备。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              私人房：创建后把邀请链接发给朋友，2–4 人即可开打。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              两种入口都需要先登录；登录后每局的排名与数据都会保存到你的战绩。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              所有新对局统一使用困难咒文，目标约 39–50
              个英文字符。私人房可自定主题；主题只换咒文内容，规则不变。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            私人房：准备与开始
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              除房主外，每个人都要点一次「我准备好了」；绿色标记表示已就绪，再点一次是「取消准备」。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              房主不必自己准备：其他人都就绪后，房主点「开始对局」即可。还有人没准备好时不会开始，界面会提示还差谁。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              两种对局都先进入独立的咒文书生成界面，完成后才进入战场并倒数 3 秒；这两段都不计入 240
              秒战斗时间。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              倒数结束的一瞬间，所有人的生命与计时同时开始。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            伤害、生命与目标
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              每人开局满血 2400。打完一条咒文造成「字符数 ×
              4」点伤害：一个字母、一个空格、一个标点都算一个字符。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              伤害不会超过对手剩余生命；没有治疗、暴击或护甲。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              目标按房间座位顺序自动选定下一位存活对手，不用点选。你的角色始终显示在左侧，视觉站位不改变攻击顺序。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              生命归零立刻出局，不能再造成伤害，但可以留在战场看这一局打完。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            咒文书：24 条，全房共用
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              一局只生成一次：AI 生成 24
              条英文咒文，组成同一本咒书，房间里每个人都照同一份顺序取用。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              英文咒文下方会显示较淡的中文译文，帮助理解含义。只输入英文；中文译文不计入进度、准确率或伤害。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              你只会看到自己当前那一条，进度各算各的；对手打到第几条不影响你。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              24 条用完后从头再来一遍：长局会重复练到同样的咒文，不会卡住。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            打字：算对、算错与修正
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              战斗界面只有一个输入框，焦点一直留在那里；换咒文时它自动清空，不用重新点。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              打对的部分保持高亮，打错会标红；退格回到错误处，或选中打错的那一段重新输入，都会从那里继续判定。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              咒文可能以 !、~、? 或 . 等不同标点结尾。输入中文或全角标点时会自动纠正：打 ！ 等同打
              !，不用切换输入法。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              中文输入法未确认的候选字不算数；候选上屏之后才参与判定。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              粘贴整段咒文会被拦下：粘贴进去的字符不造成伤害，请自己输入。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              准确率 = 打对的字符 ÷ 你输入过的字符次数；退格不算新输入，也不会抹掉已经发生的错误。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>键盘与设备</h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              常用键位：<span class={stylex.props(ui.keycap).className}>Backspace</span> 退回重打、
              <span class={stylex.props(ui.keycap).className}>Ctrl</span> +{' '}
              <span class={stylex.props(ui.keycap).className}>A</span> 全选后重打、
              <span class={stylex.props(ui.keycap).className}>Tab</span>{' '}
              在按钮与输入框之间移动焦点。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              窄屏可以查看房间、教程与成绩；正式对局请用桌面键盘。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              战斗中播放背景音乐，可用战场右上角的音乐开关暂停或开启；进入结算或离开房间后停止播放。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            结算、排名与观战
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              只剩一名存活者时立刻结束；否则打满 240
              秒结束。结束后自动切换到独立结算页，首屏显示胜利、失败或平局及你的名次。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              排名先比剩余生命，再比造成的总伤害，最后比打对的字符数；三项完全相同就并列同名次。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              被击倒后默认留在战场观战：能看到其他人的生命与进度，结束后在结算页查看完整排名，也可以再来一局或返回首页。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              开局后主动离开视作本局弃权，生命归零；等待服务器确认后返回首页，即可重新匹配。已经出局或结算后离开不会改写成绩。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              对战中的刷新或网络断开不会弃权，重连可继续同一局；断线期间计时不会暂停。
            </li>
          </ul>
        </section>
      </div>

      <div class={stylex.props(styles.guideFoot).className}>
        <Link
          class={stylex.props(styles.guideBack).className}
          data-testid="guide-home"
          to="/"
          search={{}}
        >
          <span class={stylex.props(styles.backArrow).className} aria-hidden="true">
            ←
          </span>
          <span>返回首页</span>
        </Link>
        <img
          class={stylex.props(styles.guideFootImg).className}
          src={ASSETS.sigil}
          alt=""
          width="22"
          height="22"
        />
      </div>
    </section>
  );
}
