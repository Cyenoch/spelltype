import { Show, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { roomIdSchema } from '../../../shared/validation';
import type { AppContext } from '../../app/context';
import { ui } from '../../ui/primitives';

/** 使用既有的邀请路由逻辑，包括登录后续跳转以及房间错误处理。 */
export function JoinRoom(props: { ctx: AppContext }) {
  const navigate = useNavigate();
  const [roomId, setRoomId] = createSignal('');
  const [error, setError] = createSignal('');
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;

  const join = (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = roomIdSchema.safeParse(roomId().trim().toLowerCase());
    if (!parsed.success) {
      setError('请输入完整的 24 位房间 ID，由数字和 a–f 组成。');
      input.focus();
      return;
    }
    props.ctx.setPendingInvite(parsed.data);
    dialog.close();
    void navigate({ to: '/', search: { room: parsed.data } });
  };

  return (
    <>
      <button
        type="button"
        class={stylex.props(ui.button, ui.small, styles.trigger).className}
        data-testid="home-join-room"
        aria-haspopup="dialog"
        onClick={() => {
          setError('');
          dialog.showModal();
          input.focus();
        }}
      >
        加入房间
      </button>
      <dialog
        ref={(element) => {
          dialog = element;
        }}
        class={stylex.props(ui.panel, styles.dialog).className}
        aria-labelledby="join-room-title"
        data-testid="join-room-dialog"
      >
        <form onSubmit={join} novalidate>
          <h2 id="join-room-title">加入私人房</h2>
          <p class={stylex.props(ui.smallText, ui.muted).className}>
            输入朋友分享的房间 ID。未登录时，会先前往登录并保留邀请码。
          </p>
          <label class={stylex.props(ui.label).className} for="join-room-code">
            房间 ID（邀请码）
          </label>
          <input
            ref={(element) => {
              input = element;
            }}
            id="join-room-code"
            data-testid="join-room-code"
            class={stylex.props(ui.input, ui.mono).className}
            value={roomId()}
            onInput={(event) => {
              setRoomId(event.currentTarget.value);
              setError('');
            }}
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            aria-invalid={Boolean(error())}
            aria-describedby={error() ? 'join-room-error' : 'join-room-hint'}
            placeholder="粘贴 24 位房间 ID"
          />
          <Show
            when={error()}
            fallback={
              <p id="join-room-hint" class={stylex.props(ui.hint, styles.feedback).className}>
                向房主索要邀请码，粘贴到这里即可。
              </p>
            }
          >
            <p
              id="join-room-error"
              role="alert"
              class={stylex.props(ui.smallText, styles.feedback, styles.error).className}
            >
              {error()}
            </p>
          </Show>
          <div class={stylex.props(ui.buttonRow).className}>
            <button
              type="button"
              class={stylex.props(ui.button, ui.ghost).className}
              onClick={() => dialog.close()}
            >
              取消
            </button>
            <button
              type="submit"
              class={stylex.props(ui.button, ui.primary).className}
              data-testid="join-room-submit"
            >
              进入房间
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

const styles = stylex.create({
  trigger: { marginLeft: 'auto', whiteSpace: 'nowrap' },
  dialog: {
    position: 'fixed',
    margin: 'auto',
    width: 'min(460px,calc(100vw - 32px))',
    maxHeight: 'calc(100dvh - 48px)',
    overflowY: 'auto',
    color: 'var(--ink)',
    padding: 28,
    '::backdrop': { backgroundColor: 'rgba(5,7,14,.78)', backdropFilter: 'blur(5px)' },
  },
  feedback: { margin: '8px 0 20px' },
  error: { color: '#ffabb8' },
});
