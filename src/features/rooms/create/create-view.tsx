import { For, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { createForm } from '@tanstack/solid-form';
import * as stylex from '@stylexjs/stylex';
import { MAX_THEME_CHARS, THEME_PRESETS, type ThemePreset } from '../../../../shared/protocol';
import { createRoomSchema, themeSchema } from '../../../../shared/validation';
import { parseResponse, DetailedError } from 'hono/client';
import { client } from '../../../app/client';
import { messageOf, toast } from '../../../ui/toast';
import type { AppContext } from '../../../app/context';
import { ui } from '../../../ui/primitives';
import { noticeStyles } from '../../../ui/notice.styles';
import { styles } from './create-view.styles';

interface CreateRoomForm {
  theme: string;
}

const DEFAULT_VALUES: CreateRoomForm = { theme: '' };

/** 校验问题格式不一（取决于 Schema 生成的格式）；此处提取其可读的错误文本。 */
function textOfIssue(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  if (
    issue &&
    typeof issue === 'object' &&
    'message' in issue &&
    typeof issue.message === 'string'
  ) {
    return issue.message;
  }
  return '';
}

/** 创建自定义房间：预设或自定义主题、生成邀请链接。 */
export function CreateRoomView(props: { ctx: AppContext }) {
  const navigate = useNavigate();
  let themeInput: HTMLInputElement | undefined;
  const [selectedPreset, setSelectedPreset] = createSignal('');
  const [serverError, setServerError] = createSignal<string | null>(null);

  const form = createForm(() => ({
    defaultValues: DEFAULT_VALUES,
    validators: { onSubmit: createRoomSchema },
    onSubmit: async ({ value }) => {
      try {
        const { roomId } = await parseResponse(
          client.api.rooms.$post({
            json: { theme: value.theme.trim() },
          }),
        );
        toast('房间已创建，把邀请码发给朋友吧。', 'good');
        props.ctx.setPendingInvite(roomId);
        void navigate({ to: '/', search: { room: roomId } });
      } catch (error) {
        if (error instanceof DetailedError && error.statusCode === 401) {
          props.ctx.handleAuthFailure('登录已过期，请重新登录后再创建房间。');
          return;
        }
        setServerError(messageOf(error, '创建房间失败，请稍后重试。'));
        toast(messageOf(error, '创建房间失败。'), 'error');
      }
    },
    onSubmitInvalid: ({ value }) => {
      // 主题为空是唯一可以通过键盘输入直接解决的校验错误。
      if (value.theme.trim().length === 0) themeInput?.focus();
    },
  }));

  const submitting = form.useSelector((state) => state.isSubmitting);
  const issues = form.useSelector((state) => [...(state.fieldMeta.theme?.errors ?? [])]);
  const maintenance = props.ctx.maintenance;
  const blocked = () => maintenance.admissionBlocked();

  const errorText = () => {
    const invalid = [...new Set(issues().map(textOfIssue))]
      .filter((message) => message.length > 0)
      .join(' ');
    return serverError() ?? (invalid.length > 0 ? invalid : null);
  };

  const applyPreset = (preset: ThemePreset) => {
    setSelectedPreset(preset.id);
    form.setFieldValue('theme', preset.theme);
    themeInput?.focus();
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setServerError(null);
    void form.handleSubmit();
  };

  return (
    <section data-testid="view-create">
      <form onSubmit={submit}>
        <div class={stylex.props(ui.panel).className}>
          <div class={stylex.props(ui.panelHead).className}>
            <h1>创建私人房</h1>
            <span class={stylex.props(ui.eyebrow).className}>2–4 人</span>
          </div>
          <p class={stylex.props(ui.muted).className}>
            选一个咒文主题，邀请朋友来一场对决：预设主题按主题共用咒文书，通常更快开战；自定义主题每局单独铸造。
          </p>

          <div
            class={stylex.props(ui.notice, noticeStyles.warn).className}
            data-testid="create-service-notice"
            data-tone="warn"
            data-state={maintenance.draining() ? 'draining' : 'unavailable'}
            hidden={!blocked()}
          >
            {blocked()
              ? maintenance.draining()
                ? '系统维护中：暂时无法创建新房间，维护结束后即可创建。'
                : '暂时无法获取服务状态：已暂停创建新房间，恢复后即可创建。'
              : ''}
          </div>

          <hr class={stylex.props(ui.rule).className} />

          <h3>主题</h3>
          <div class={stylex.props(ui.chips, styles.presetRow).className}>
            <For each={THEME_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class={
                    stylex.props(ui.chip, selectedPreset() === preset.id ? ui.chipSelected : null)
                      .className
                  }
                  data-testid="theme-preset"
                  data-theme={preset.theme}
                  data-preset={preset.id}
                  aria-pressed={selectedPreset() === preset.id}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              )}
            </For>
          </div>

          <label class={stylex.props(ui.label).className} for="room-theme">
            自定义主题描述
          </label>
          <form.Field name="theme" validators={{ onChange: themeSchema }}>
            {(field) => {
              const length = () => Array.from(field().state.value).length;
              return (
                <>
                  <input
                    ref={(el) => {
                      themeInput = el;
                    }}
                    type="text"
                    id="room-theme"
                    class={stylex.props(ui.input).className}
                    data-testid="room-theme-input"
                    maxlength={MAX_THEME_CHARS}
                    placeholder="例如：深夜图书馆的禁书目录"
                    aria-describedby="room-theme-counter"
                    spellcheck={false}
                    value={field().state.value}
                    onBlur={field().handleBlur}
                    onInput={(event) => {
                      setSelectedPreset('');
                      field().handleChange(event.currentTarget.value);
                    }}
                  />
                  <span
                    id="room-theme-counter"
                    class={stylex.props(ui.hint).className}
                    data-testid="room-theme-counter"
                    data-over={length() > MAX_THEME_CHARS ? 'true' : 'false'}
                  >
                    {length()} / {MAX_THEME_CHARS}
                  </span>
                </>
              );
            }}
          </form.Field>

          <p
            class={stylex.props(ui.smallText).className}
            data-testid="create-error"
            data-tone="error"
            hidden={errorText() === null}
          >
            {errorText() ?? ''}
          </p>

          <div class={stylex.props(ui.buttonRow, styles.submitRow).className}>
            <button
              type="submit"
              class={stylex.props(ui.button, ui.primary).className}
              data-testid="room-create-submit"
              disabled={submitting() || blocked()}
            >
              {blocked()
                ? '维护中，暂不能创建'
                : submitting()
                  ? '正在创建…'
                  : '创建房间并获取邀请码'}
            </button>
            <button
              type="button"
              class={stylex.props(ui.button, ui.ghost).className}
              data-testid="create-back"
              onClick={() => void navigate({ to: '/', search: {} })}
            >
              返回首页
            </button>
          </div>
        </div>
      </form>

      <div class={stylex.props(ui.panel).className}>
        <h2>接下来的流程</h2>
        <ol class={stylex.props(ui.steps).className}>
          <li class={stylex.props(styles.step).className}>
            创建后进入房间大厅，点击复制邀请码发给朋友；朋友在首页选择「加入房间」（2–4 人都可以）。
          </li>
          <li class={stylex.props(styles.step).className}>全员准备后，由房主开始对决。</li>
          <li class={stylex.props(styles.step).className}>
            咒文准备就绪后进入战斗，等待不计入对战时间。
          </li>
          <li class={stylex.props(styles.step).className}>
            开场倒数 3 秒后进入 240
            秒连续战斗：完成咒文即同时命中所有存活对手（总伤害平均分配），生命归零出局。
          </li>
        </ol>
      </div>
    </section>
  );
}
