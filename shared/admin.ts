import type {
  AccountBan,
  AccountRole,
  EndReason,
  MatchResult,
  OpponentKind,
  Phase,
  RoomMode,
  Spell,
  User,
} from './protocol';

/**
 * 管理端封禁时长的上限：100 年。并非业务预测，只是给“定时”封禁一个
 * 有界的输入上限，永久封禁以 `durationMs: null` 表达，与超长时长无关。
 */
export const MAX_BAN_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export interface AdminPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminListSearch {
  page: number;
  q: string;
}

/** 管理端账户视图。`ban` 为响应时刻仍生效的封禁；过期的定时封禁读取为 `null`。 */
export interface AdminUser extends User {
  role: AccountRole;
  createdAt: number;
  ban: AccountBan | null;
}

export interface AdminUserStats {
  games: number;
  wins: number;
  bestCpm: number;
  averageCpm: number | null;
  averageAccuracy: number | null;
  damageDealt: number;
  spellsCast: number;
  correctChars: number;
  durationMs: number;
  lastPlayedAt: number | null;
}

export interface AdminResult extends MatchResult {
  userId: string;
  username: string;
  accountExists: boolean;
  roomId: string;
}

export interface AdminUserDetail {
  user: AdminUser;
  stats: AdminUserStats;
  activeSessions: number;
  ghostCount: number;
  activeRoom: { roomId: string; matchId: string | null; phase: Phase; theme: string } | null;
  history: AdminPage<AdminResult>;
}

export interface AdminMatch {
  id: string;
  roomId: string;
  theme: string;
  phase: Phase;
  mode: RoomMode;
  opponentKind: OpponentKind;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  participantCount: number;
}

export interface AdminParticipant {
  userId: string;
  username: string;
  accountExists: boolean;
  hp: number;
  spellsCast: number;
  damageDealt: number;
  cpm: number;
}

export interface AdminMatchDetail {
  match: AdminMatch;
  endReason: EndReason | null;
  persistence: string | null;
  participants: AdminParticipant[];
  results: AdminResult[];
  spellBook: Spell[] | null;
  currentBookTheme: string | null;
  isCurrentRoomMatch: boolean;
}

export interface AdminBook {
  theme: string;
  spellCount: number;
  publishedAt: number | null;
  refreshing: boolean;
  matchCount: number;
}

export interface AdminBookDetail {
  book: AdminBook;
  spells: Spell[];
  matches: AdminPage<AdminMatch>;
}

export interface AdminOverview {
  users: number;
  admins: number;
  matches: number;
  activeMatches: number;
  books: number;
  ghosts: number;
  recentUsers: AdminUser[];
  recentMatches: AdminMatch[];
}
