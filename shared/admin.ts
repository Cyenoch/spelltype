import type {
  AccountRole,
  EndReason,
  MatchResult,
  OpponentKind,
  Phase,
  RoomMode,
  Spell,
  User,
} from './protocol';

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

export interface AdminUser extends User {
  role: AccountRole;
  createdAt: number;
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
