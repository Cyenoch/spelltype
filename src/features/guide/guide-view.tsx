import { Link } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { ASSETS } from '../../pixi/assets';
import { ui } from '../../ui/primitives';
import { MatchFacts } from '../home/home-view';
import { styles } from '../home/home.styles';

/** 面向玩家的规则详解页面，独立于首页紧凑的新手简引。 */
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
              快速匹配：寻找一名对手，随机选择一个预设主题；双方进入房间即自动开始，无需点准备。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              排队期间可练习咒文，完成一句后按 Enter
              继续。练习成绩仅在当前页面保留，不计入战绩，也不影响匹配。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              私人房：创建后在大厅复制邀请码发给朋友；朋友在首页点击「加入房间」输入邀请码，2–4
              人即可开打。
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
              两种对局都先进入独立的咒文书准备界面，咒文就绪后才进入战场并倒数 3 秒；这段等待不计入
              240 秒战斗时间，咒文书已备好时几乎瞬间通过。
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
              4」点总伤害，平均分给场上所有其他存活对手（人数除不尽时出现小数）：一个字母、一个空格、一个标点都算一个字符。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              分到每个人头上的伤害不会超过其剩余生命；没有治疗、暴击或护甲。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              施法自动命中场上所有其他存活对手，不用点选；你自己和已出局的人不会成为目标。你的角色始终显示在左侧，视觉站位不改变攻击范围。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              服务器每 100
              毫秒结算一批施法：同一批的命中同时生效、画面同时命中；在你这批施法落地前，下一批不会开始结算。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              生命归零立刻出局，不能再造成伤害；同一批攻击可以同时放倒多人，出局后可以留在战场看这一局打完。
            </li>
          </ul>
        </section>

        <section class={stylex.props(ui.panel, styles.guideSection).className}>
          <h2 class={stylex.props(ui.title, styles.guideSectionTitle).className}>
            咒文书：24 条，按主题共用
          </h2>
          <ul class={stylex.props(ui.steps).className}>
            <li class={stylex.props(styles.guideStep).className}>
              预设主题的房间按主题共用咒文书：AI 铸造 24
              条英文咒文与中文释义组成一本书，同一主题的每个房间都照同一份顺序取用。咒文书发布后 5
              分钟内视为新鲜；过期后由下一场开战的对局触发换新，换新期间先开战的房间稍候新一册，同时开战的其他房间继续使用旧咒文。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              自定义主题不共用咒文书：每一局都为这一局单独铸造 24 条咒文。
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
              点击咒文栏直接输入，无需单独的输入框；换咒文时输入自动清空，不用重新点。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              已输入的文字按元素流光填充，当前字符为黄色，后续字符为淡灰色。每个字符都有短促火花，打错会标红；退格或用键盘选区修正后继续输入。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              角色周围的符文随施法进度逐渐增加，名字下方显示双方进度；达到 85%
              时提示「即将施法」。系统开启减少动态效果后，保留进度和颜色，停止漂浮、火花和抖动。
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
              在按钮与咒文栏之间移动焦点。
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
              只剩一名存活者，或最后几名玩家在同一批攻击中同时出局时立刻结束；否则打满 240
              秒结束。结束后自动切换到独立结算页，首屏显示胜利、失败或平局及你的名次。
            </li>
            <li class={stylex.props(styles.guideStep).className}>
              存活者只按剩余生命排名：生命相同就并列同一名次，与伤害或字符数无关。已出局的人按出局时间排名，同一批同时倒下的并列同一名次——最后一批同归于尽即并列第一。
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
