import { afterEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerConfig } from '../../server/config';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('only an absent maintenance credential disables automation; malformed configuration fails', async () => {
  expect((await readServerConfig({})).maintenanceToken).toBeNull();
  await rejects(readServerConfig({ MAINTENANCE_TOKEN: '' }), /64 lowercase hexadecimal/);
  await rejects(
    readServerConfig({ MAINTENANCE_TOKEN: 'A'.repeat(64) }),
    /64 lowercase hexadecimal/,
  );
});

test('mounted secrets work but ambiguous inline and file credentials are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spelltype-config-'));
  roots.push(root);
  const filename = join(root, 'maintenance-token');
  const token = '0123456789abcdef'.repeat(4);
  await Bun.write(filename, `${token}\n`);
  expect((await readServerConfig({ MAINTENANCE_TOKEN_FILE: filename })).maintenanceToken).toBe(
    token,
  );
  await rejects(
    readServerConfig({ MAINTENANCE_TOKEN: '', MAINTENANCE_TOKEN_FILE: filename }),
    /Set only MAINTENANCE_TOKEN or MAINTENANCE_TOKEN_FILE/,
  );
});

test('the WeChat bridge env triple resolves with an inline or file-backed app key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spelltype-config-'));
  roots.push(root);
  const filename = join(root, 'bridge-app-key');
  await Bun.write(filename, '  spelltype-file-app-key-0123456789  \n');
  const env = {
    WECHAT_BRIDGE_BASE_URL: 'https://bridge.example/',
    WECHAT_BRIDGE_APP_ID: '  spelltype-test-app  ',
    WECHAT_BRIDGE_APP_KEY_FILE: filename,
  };
  expect((await readServerConfig(env)).wechatBridge).toEqual({
    baseUrl: 'https://bridge.example',
    appId: 'spelltype-test-app',
    appKey: 'spelltype-file-app-key-0123456789',
  });
  expect(
    (
      await readServerConfig({
        WECHAT_BRIDGE_BASE_URL: env.WECHAT_BRIDGE_BASE_URL,
        WECHAT_BRIDGE_APP_ID: env.WECHAT_BRIDGE_APP_ID,
        WECHAT_BRIDGE_APP_KEY: '  spelltype-inline-app-key-0123456789  ',
      })
    ).wechatBridge?.appKey,
  ).toBe('spelltype-inline-app-key-0123456789');
  await rejects(
    readServerConfig({ ...env, WECHAT_BRIDGE_APP_KEY: 'spelltype-inline-app-key-0123456789' }),
  );
});

test('partial or malformed WeChat bridge credentials refuse to boot', async () => {
  // 不配置桥接在开发环境就是合法的禁用。
  expect((await readServerConfig({})).wechatBridge).toBeNull();
  await rejects(readServerConfig({ WECHAT_BRIDGE_BASE_URL: 'https://bridge.example' }));
  await rejects(
    readServerConfig({
      WECHAT_BRIDGE_APP_ID: 'spelltype-test-app',
      WECHAT_BRIDGE_APP_KEY: 'spelltype-inline-app-key',
    }),
  );
  await rejects(
    readServerConfig({
      WECHAT_BRIDGE_BASE_URL: 'https://bridge.example',
      WECHAT_BRIDGE_APP_ID: 'spelltype-test-app',
      WECHAT_BRIDGE_APP_KEY: 'short',
    }),
  );
  await rejects(
    readServerConfig({
      WECHAT_BRIDGE_BASE_URL: 'https://bridge.example/bridge/start',
      WECHAT_BRIDGE_APP_ID: 'spelltype-test-app',
      WECHAT_BRIDGE_APP_KEY: 'spelltype-inline-app-key',
    }),
  );
  const production = {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://app.example',
    DATABASE_URL: 'postgres://db.example/spelltype',
  };
  const app = {
    WECHAT_BRIDGE_APP_ID: 'spelltype-test-app',
    WECHAT_BRIDGE_APP_KEY: 'spelltype-inline-app-key',
  };
  await rejects(
    readServerConfig({ ...production, ...app, WECHAT_BRIDGE_BASE_URL: 'http://bridge.example' }),
  );
  const configured = await readServerConfig({
    ...production,
    ...app,
    WECHAT_BRIDGE_BASE_URL: 'https://bridge.example',
  });
  expect(configured.wechatBridge?.appId).toBe(app.WECHAT_BRIDGE_APP_ID);
  await rejects(readServerConfig(production));
});
