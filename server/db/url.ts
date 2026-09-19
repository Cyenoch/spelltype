/**
 * 统一解析和判定数据库 URL 的唯一入口。
 *
 * 本模块供两种驱动共享：用于本地开发和测试的 PGlite，以及用于生产环境 PostgreSQL 服务器的 Bun 原生 SQL 客户端。
 * 数据库 URL 均在此处完成解析——针对 `pglite://` 绝不使用 WHATWG 的 `URL` 构造函数，因为 `:memory:` 属于非法主机名，
 * 在我们对格式完成分类前就会抛出异常。任何格式错误或不受支持的 URL 都会被直接拒绝；绝不静默回退到内存数据库，
 * 否则会导致开发人员的数据被静默分叉。
 */

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUrlError';
  }
}

/** 已分类解析的数据库 URL。`pglite-memory` 会打开一个进程内的临时数据库。 */
export type ParsedDatabaseUrl =
  | { driver: 'pglite'; dataDir: string }
  | { driver: 'pglite-memory' }
  | { driver: 'postgres'; connectionString: string };

const PGLITE_PREFIX = 'pglite://';
const POSTGRES_SCHEMES: Record<string, true> = { 'postgres:': true, 'postgresql:': true };

const SUPPORTED_FORMS =
  'supported forms: pglite://./relative/path, pglite:///absolute/path, pglite://:memory:, postgresql://host/db';

function reject(why: string): never {
  // 绝不将原始 URL 明文回显：PostgreSQL 连接字符串通常包含认证凭据。
  throw new DatabaseUrlError(`Unsupported database URL (${why}). ${SUPPORTED_FORMS}`);
}

/**
 * 在不触碰文件系统或网络的前提下对数据库 URL 进行分类，使得运行时
 * （`openDatabase`）与 Drizzle CLI 配置能够共享同一套语法规则。
 */
export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') reject('the URL is empty');

  if (url.startsWith(PGLITE_PREFIX)) {
    const rest = url.slice(PGLITE_PREFIX.length);
    if (rest === ':memory:') return { driver: 'pglite-memory' };
    if (rest === '' || rest.includes('?') || rest.includes('#')) {
      reject('pglite URLs take a bare filesystem path or :memory:');
    }
    if (rest.startsWith('/')) return { driver: 'pglite', dataDir: rest };
    if (rest.startsWith('./')) return { driver: 'pglite', dataDir: rest };
    reject('pglite data directories start with "/" or "./"');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    reject('the URL does not parse');
  }
  if (!POSTGRES_SCHEMES[parsed.protocol]) {
    reject(`scheme ${JSON.stringify(parsed.protocol)} is not a database driver`);
  }
  // PostgreSQL 连接字符串原样透传；由底层客户端管理其具体语法
  // （主机、端口、sslmode、unix 套接字等）。
  return { driver: 'postgres', connectionString: url };
}
