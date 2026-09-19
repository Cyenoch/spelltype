import { z } from 'zod';

/**
 * 服务端、管理运维工具和客户端共用的维护契约 —— schema 优先，
 * 确保每个消费者校验的都是相同的传输格式，而非各自手工实现。
 *
 * 维护状态是全局持久化的数据库状态，并非针对单个房间或单个版本的标记。
 * `runtime_control` 行持有 `mode`；`revision` 是每次状态变更必须引用的 CAS 令牌；
 * `updatedAt` 是最后一次提交变更的墙钟毫秒时间戳。本模块中的其他内容均为派生观测数据：
 * 排空计数、运行时租约认知状态、就绪状态。
 *
 * 业务协议中故意不包含构建标识 —— `ServiceStatus` 携带 `buildId` 仅作为人工和部署工具的信息参考。
 */

export const maintenanceModeSchema = z.enum(['open', 'draining']);

/** `open`: 服务器允许创建新房间和新的排队票据。`draining`: 不允许。 */
export type MaintenanceMode = z.infer<typeof maintenanceModeSchema>;

export const maintenanceInfoSchema = z.object({
  mode: maintenanceModeSchema,
  /** 每次提交转移时自增；调用方据此进行 CAS。 */
  revision: z.number().int(),
  /** 最后一次提交转移时的墙钟毫秒时间戳。 */
  updatedAt: z.number().int(),
});

/** 持久化保存在 `runtime_control` 中的权威维护状态指针。 */
export type MaintenanceInfo = z.infer<typeof maintenanceInfoSchema>;

export const drainStatusSchema = maintenanceInfoSchema.extend({
  /** 处于 `generating`/`countdown`/`playing` 状态的房间：仍在进行中的对局。 */
  activeMatches: z.number().int(),
  /** 预留 TTL 仍然有效的快速匹配席位。 */
  liveReservations: z.number().int(),
  /** 仍在等待对手的排队票据（进入维护准入控制时会删除这些票据）。 */
  waitingTickets: z.number().int(),
  /** 结果簿记仍处于 `saving` 或 `error` 的已结束房间。 */
  pendingResults: z.number().int(),
  /** 当租约在未优雅释放的情况下失效时为 false：此时运行时状态未知。 */
  runtimeKnown: z.boolean(),
  /** 控制行上的当前运行时归属代际（epoch）。 */
  runtimeEpoch: z.number().int(),
  /** 处于 draining 状态 ∧ 无阻塞项 ∧ 运行时状态已知。 */
  ready: z.boolean(),
});

/**
 * 在控制行锁保护下统计的仍阻塞运行时替换的工作项。仅在处于 draining 且阻塞工作项为零、
 * 且数据库能确认运行时状态时，`ready` 才为 true。
 */
export type DrainStatus = z.infer<typeof drainStatusSchema>;

export const serviceStatusSchema = z.object({
  maintenance: maintenanceInfoSchema,
  protocolVersion: z.string(),
  /** 信息性构建标识；绝不用于鉴权或路由。 */
  buildId: z.string(),
});

/** `GET /api/status` 提供的公开状态文档。 */
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

const messages = {
  'maintenance:draining': '服务器维护中，新的对局暂时无法开始，进行中的对局不受影响。',
  'maintenance:unavailable': '服务状态暂不可用，请稍后重试。',
} as const;

export type MaintenanceCode = keyof typeof messages;

/**
 * 因服务正在排空（或其状态无法被证实）而拒绝开展新工作的错误。
 * 始终返回 503：这种情况是部署的主动选择，或是故障闭锁的未知状态，客户端应稍后重试而非视请求为非法。
 */
export class MaintenanceError extends Error {
  readonly status = 503;

  constructor(readonly code: MaintenanceCode) {
    super(messages[code]);
    this.name = 'MaintenanceError';
  }
}
