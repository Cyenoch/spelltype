import type { QueryClient } from '@tanstack/solid-query';
import type { ServerClock } from './clock';
import type { MaintenanceService } from './maintenance';
import type { NotificationService } from './notifications';
import type { Session } from './session';
import type { Tone } from '../ui/toast';

/** 服务端重定向回 /auth 的登录失败类型；认证视图会以支持重试的形式展示它们。 */
export type WechatLoginError = 'wechat_failed' | 'wechat_unavailable';
export type RoomLinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** 应用级服务；页面级状态属于 Solid 组件。 */
export interface AppContext {
  readonly session: Session;
  readonly queryClient: QueryClient;
  readonly clock: ServerClock;
  /** 对局事件提醒服务；单例，归会话所有。 */
  readonly notifications: NotificationService;
  /** 部署环境的维护状态；外层壳组件据此渲染运维提示信息。 */
  readonly maintenance: MaintenanceService;
  pendingInvite(): string | null;
  setPendingInvite(roomId: string | null): void;
  notify(message: string, tone?: Tone): void;
  reportGraphicsFailure(reason: string): void;
  handleAuthFailure(reason: string): void;
  setRoomConnection(state: RoomLinkState): void;
}

export interface AppRouterContext {
  readonly app: AppContext;
  notice(): string;
  connection(): RoomLinkState;
  graphicsFailed(): boolean;
}
