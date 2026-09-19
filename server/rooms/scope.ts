import type { RoomSocket, GenerateSpells } from '../contracts';
import type { QueryDatabase, Transaction } from '../db';
import type { InputPolicyMode } from '../../shared/protocol';
import { pushSnapshots } from './snapshots';
import { INPUTS_PER_SECOND } from './rules';

/** 套接字被接纳时所关联的身份信息，在连接时固定一次。 */
export type SocketAuth = {
  userId: string;
  username: string;
  connId: string;
  sessionHash: string;
  sessionExpires: number;
  /** 本连接原生升级时所接受的网络传输协议。 */
  protocolVersion: string;
};

/**
 * 房间自身的套接字注册表。Bun 的服务端套接字没有每个套接字的
 * 独立监听器机制，因此引擎在此处跟踪连接附着情况 —— 以套接字
 * 对象身份作为键。任何套接字或连接都不会在进程重启后存活。
 */
export class SocketRegistry {
  private readonly entries = new Map<RoomSocket, SocketAuth>();

  /** 记录单个已接纳套接字的授权信息。 */
  attach(socket: RoomSocket, auth: SocketAuth): void {
    this.entries.set(socket, auth);
  }

  /** 移除套接字；返回其携带的身份信息（若存在）。 */
  detach(socket: RoomSocket): SocketAuth | undefined {
    const auth = this.entries.get(socket);
    this.entries.delete(socket);
    return auth;
  }

  /** 套接字被接纳时关联的身份，未知套接字返回 `null`。 */
  metaOf(socket: RoomSocket): SocketAuth | null {
    return this.entries.get(socket) ?? null;
  }

  /** 本房间当前跟踪的所有套接字，无论是否打开。 */
  list(): RoomSocket[] {
    return [...this.entries.keys()];
  }
}

/**
 * 房间针对单个连接的输入配额。刻意设计为仅存于内存：突发流量是单个
 * 活跃套接字的属性，重启重置该配额不会改变持久化比赛所依赖的任何决策。
 */
export class InputBudget {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  /** 接纳一个数据包，或在该连接用完其当前秒的配额后予以拒绝。 */
  allow(connId: string, now: number): boolean {
    const window = this.windows.get(connId);
    if (!window || now - window.startedAt >= 1_000) {
      this.windows.set(connId, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= INPUTS_PER_SECOND) return false;
    window.count++;
    return true;
  }

  /** 遗忘单个连接：关闭、被替换或被撤销的套接字不再有配额可消耗。 */
  release(connId: string): void {
    this.windows.delete(connId);
  }
}

/**
 * 房间领域模块所需的一切：房间标识、其数据库（或当前运行命令的事务）、
 * 活跃套接字及其单连接配额。显式传递该作用域可保持领域逻辑与引擎解耦，
 * 同时引擎仍是拥有串行化、定时器和套接字生命周期的唯一主体。
 */
export interface RoomScope {
  readonly roomId: string;
  /** 普通（非事务）数据库访问；命令事务通过 `transact` 流转。 */
  readonly db: QueryDatabase;
  readonly generate: GenerateSpells;
  readonly input: InputBudget;
  readonly registry: SocketRegistry;
  /** 本运行时开启的每场比赛锁定在其房间数据行中的打字时间策略模式。 */
  readonly inputPolicyMode: InputPolicyMode;
  /**
   * 本引擎当前正在等待的生成尝试（若存在）。引擎自身的记账逻辑
   * 绝不能将其本地正在进行的尝试视为已崩溃 —— 只有无活跃后续流程认领的 claim 才会视为中断。
   */
  inFlightGeneration: string | null;
  now(): number;
  /** 单个受隔离保护的变更事务：在执行事务体之前，在行锁下断言所有权。 */
  transact<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** 将已提交状态的按席位快照发布至所有已授权的套接字。 */
  push(): Promise<void>;
  /** 重新计算房间最早的持久化截止时间，并重新挂载运行时定时器。 */
  arm(): Promise<void>;
}

export interface RoomScopeOptions {
  roomId: string;
  db: QueryDatabase;
  generate: GenerateSpells;
  registry: SocketRegistry;
  /** 本运行时开启的每场比赛锁定在其房间数据行中的打字时间策略模式。 */
  inputPolicyMode: InputPolicyMode;
  /** 引擎的配额跟踪器；省略时该作用域会创建一个全新的跟踪器。 */
  input?: InputBudget;
  /** 默认在普通数据库上运行事务体（自动提交）—— 用于单元测试切面。 */
  transact?<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** 默认为通过注册表进行真实的快照广播。 */
  push?(scope: RoomScope): Promise<void> | void;
  /** 默认为空操作 —— 仅活跃引擎拥有定时器。 */
  arm?(scope: RoomScope): Promise<void> | void;
}

/**
 * 构建单个房间的作用域。活跃引擎提供其自带的受保护 `transact`、
 * 快照广播和定时器挂载；测试则直接使用默认值驱动领域逻辑，
 * 从而确保生产路径是唯一的执行路径。
 */
export function createRoomScope(options: RoomScopeOptions): RoomScope {
  const scope: RoomScope = {
    roomId: options.roomId,
    db: options.db,
    generate: options.generate,
    input: options.input ?? new InputBudget(),
    registry: options.registry,
    inputPolicyMode: options.inputPolicyMode,
    inFlightGeneration: null,
    now: () => Date.now(),
    transact<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      if (options.transact) return options.transact(fn);
      return fn(options.db as Transaction);
    },
    async push(): Promise<void> {
      if (options.push) await options.push(scope);
      else await pushSnapshots(scope);
    },
    async arm(): Promise<void> {
      if (options.arm) await options.arm(scope);
    },
  };
  return scope;
}
