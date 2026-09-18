import './styles.css';
import { App } from './app';

async function boot(): Promise<void> {
  try {
    await new App().boot();
  } catch (error) {
    const root = document.getElementById('app');
    if (root) {
      root.textContent = `应用启动失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
    throw error;
  } finally {
    document.getElementById('boot')?.remove();
  }
}

void boot();
