import { ErrorBoundary } from 'solid-js';
import { render } from 'solid-js/web';
import './styles.css';
import { App } from './app/app';

const root = document.getElementById('root');
if (!root) throw new Error('缺少应用挂载节点');
const dispose = render(
  () => (
    <ErrorBoundary
      fallback={(error, reset) => (
        <main role="alert">
          <h1>应用启动失败</h1>
          <p>{error instanceof Error ? error.message : '未知错误'}</p>
          <button onClick={reset}>重试</button>
        </main>
      )}
    >
      <App />
    </ErrorBoundary>
  ),
  root,
);

const unload = (event: PageTransitionEvent) => {
  if (!event.persisted) dispose();
};
window.addEventListener('pagehide', unload);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener('pagehide', unload);
    dispose();
  });
