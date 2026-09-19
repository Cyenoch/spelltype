import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { parseDatabaseUrl } from './server/db/url';

/**
 * Drizzle CLI 配置（迁移生成与检查）。
 *
 * URL 来自与服务端相同的来源与语法：`DATABASE_URL`，或在密钥文件部署下使用
 * `DATABASE_URL_FILE` —— 与 `server/config.ts` 的读取方式完全一致 ——
 * 因此把 CLI 指向某个数据库时，绝不会使用与服务端不同的变量。
 * 只有 `generate` 不需要连接；其他会接触数据库的命令都使用它所指向的目标。
 * 兜底值为开发服务器自身的默认数据库（PGlite），
 * 因此在一个全新检出的仓库中直接运行 `drizzle-kit generate` 即可工作。
 */
const raw =
  process.env.DATABASE_URL ??
  (process.env.DATABASE_URL_FILE !== undefined
    ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8')
    : 'pglite://./.data/spelltype');
const parsed = parseDatabaseUrl(raw);

export default defineConfig(
  parsed.driver === 'postgres'
    ? {
        dialect: 'postgresql',
        schema: './server/db/schema.ts',
        out: './drizzle',
        dbCredentials: { url: parsed.connectionString },
      }
    : {
        dialect: 'postgresql',
        driver: 'pglite',
        schema: './server/db/schema.ts',
        out: './drizzle',
        dbCredentials: { url: parsed.driver === 'pglite-memory' ? ':memory:' : parsed.dataDir },
      },
);
