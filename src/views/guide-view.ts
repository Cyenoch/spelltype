import { ASSETS } from '../assets';
import { el } from '../dom';
import type { AppContext, View } from '../context';
import './home.css';

/** Player-facing rules, separate from the compact homepage primer. */
export class GuideView implements View {
  readonly el: HTMLElement;

  constructor(private readonly ctx: AppContext) {
    this.el = el(
      'section',
      { class: 'guide', testid: 'view-guide' },
      el(
        'header',
        { class: 'guide__head' },
        el(
          'div',
          { class: 'guide__head-main' },
          el('span', { class: 'hero__eyebrow', text: '完整教程' }),
          el('h1', { class: 'guide__title', text: '从第一秒到结算' }),
          el('p', {
            class: 'guide__lead',
            text: '一场咒文对决的全部规则：怎么开局、伤害怎么算、打字时会发生什么、打完怎么排名。',
          }),
          el(
            'div',
            { class: 'hero__facts' },
            el('div', { class: 'fact' }, el('b', { text: '2400' }), el('span', { text: '每人生命' })),
            el('div', { class: 'fact' }, el('b', { text: '240 秒' }), el('span', { text: '单局时长' })),
            el('div', { class: 'fact' }, el('b', { text: '×4' }), el('span', { text: '每字伤害' })),
            el('div', { class: 'fact' }, el('b', { text: '24 条' }), el('span', { text: '共享咒文' })),
          ),
        ),
        el(
          'a',
          {
            class: 'guide__back',
            testid: 'guide-back',
            attrs: { href: '/' },
            on: { click: (event) => this.openHome(event) },
          },
          el('span', { class: 'guide__back-arrow', attrs: { 'aria-hidden': 'true' }, text: '←' }),
          el('span', { text: '返回首页' }),
        ),
      ),
      el(
        'div',
        { class: 'guide__grid' },
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '开局：匹配还是私人房' }),
          el(
            'ul',
            { class: 'steps' },
            el('li', {}, '快速匹配：选择难度后寻找一名对手，双方进入房间即自动开始，无需点准备。'),
            el('li', {}, '私人房：创建后把邀请链接发给朋友，2–4 人即可开打。'),
            el('li', {}, '两种入口都需要先登录；登录后每局的排名与数据都会保存到你的战绩。'),
            el('li', {}, '私人房的主题与难度由创建者定；主题只换咒文内容，规则不变。'),
          ),
        ),
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '私人房：准备与开始' }),
          el(
            'ul',
            { class: 'steps' },
            el('li', {}, '除房主外，每个人都要点一次「我准备好了」；绿色标记表示已就绪，再点一次是「取消准备」。'),
            el('li', {}, '房主不必自己准备：其他人都就绪后，房主点「开始对局」即可。还有人没准备好时不会开始，界面会提示还差谁。'),
            el('li', {}, '开始后先「生成咒文」，再「开场倒数」3 秒——这两段都不算进 240 秒战斗时间。'),
            el('li', {}, '倒数结束的一瞬间，所有人的生命与计时同时开始。'),
          ),
        ),
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '伤害、生命与目标' }),
          el(
            'ul',
            { class: 'steps' },
            el('li', {}, '每人开局满血 2400。打完一条咒文造成「字符数 × 4」点伤害：一个汉字、一个字母、一个标点都算一个字符。'),
            el('li', {}, '伤害不会超过对手剩余生命；没有治疗、暴击或护甲。'),
            el('li', {}, '目标自动选定：从你的座位出发，顺时针下一个还活着的人。不用点选，也换不了目标。'),
            el('li', {}, '生命归零立刻出局，不能再造成伤害，但可以留在战场看这一局打完。'),
          ),
        ),
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '咒文书：24 条，全房共用' }),
          el(
            'ul',
            { class: 'steps' },
            el('li', {}, '一局只生成一次：24 条咒文组成同一本咒书，房间里每个人都照同一份顺序取用。'),
            el('li', {}, '你只会看到自己当前那一条，进度各算各的；对手打到第几条不影响你。'),
            el('li', {}, '24 条用完后从头再来一遍：长局会重复练到同样的咒文，不会卡住。'),
          ),
        ),
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '打字：算对、算错与修正' }),
          el(
            'ul',
            { class: 'steps' },
            el('li', {}, '战斗界面只有一个输入框，焦点一直留在那里；换咒文时它自动清空，不用重新点。'),
            el('li', {}, '打对的部分保持高亮，打错会标红；退格回到错误处，或选中打错的那一段重新输入，都会从那里继续判定。'),
            el('li', {}, '中文输入法未确认的候选字不算数；候选上屏之后才参与判定。'),
            el('li', {}, '粘贴整段咒文会被拦下：粘贴进去的字符不造成伤害，请自己输入。'),
            el('li', {}, '准确率 = 打对的字符 ÷ 你输入过的字符次数；退格不算新输入，也不会抹掉已经发生的错误。'),
          ),
        ),
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '键盘与设备' }),
          el(
            'ul',
            { class: 'steps' },
            el(
              'li',
              {},
              '常用键位：',
              el('span', { class: 'keycap', text: 'Backspace' }),
              ' 退回重打、',
              el('span', { class: 'keycap', text: 'Ctrl' }),
              ' + ',
              el('span', { class: 'keycap', text: 'A' }),
              ' 全选后重打、',
              el('span', { class: 'keycap', text: 'Tab' }),
              ' 在按钮与输入框之间移动焦点。',
            ),
            el('li', {}, '窄屏可以查看房间、教程与成绩；正式对局请用桌面键盘。'),
          ),
        ),
        el(
          'section',
          { class: 'panel guide__section' },
          el('h2', { text: '结算、排名与观战' }),
          el(
            'ul',
            { class: 'steps' },
            el('li', {}, '只剩一名存活者时立刻结束；否则打满 240 秒结束。'),
            el('li', {}, '排名先比剩余生命，再比造成的总伤害，最后比打对的字符数；三项完全相同就并列同名次。'),
            el('li', {}, '被击倒后默认留在战场观战：能看到其他人的生命与进度，结束后看到完整排名。'),
            el('li', {}, '也可以直接退出房间；观战与否都不影响你的成绩记录。'),
          ),
        ),
      ),
      el(
        'div',
        { class: 'guide__foot' },
        el(
          'a',
          {
            class: 'guide__back guide__back--foot',
            testid: 'guide-home',
            attrs: { href: '/' },
            on: { click: (event) => this.openHome(event) },
          },
          el('span', { class: 'guide__back-arrow', attrs: { 'aria-hidden': 'true' }, text: '←' }),
          el('span', { text: '返回首页' }),
        ),
        el('img', { attrs: { src: ASSETS.sigil, alt: '', width: 22, height: 22 } }),
      ),
    );
  }

  destroy(): void {
    this.el.remove();
  }

  /** Plain clicks stay in the app; modified clicks keep the browser's own tab/window behaviour. */
  private openHome(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    this.ctx.goHome();
  }
}
