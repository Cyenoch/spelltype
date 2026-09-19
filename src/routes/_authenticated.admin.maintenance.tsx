import { createFileRoute, redirect } from '@tanstack/solid-router';
import { MaintenanceAdminView } from '../features/admin/maintenance-view';

export const Route = createFileRoute('/_authenticated/admin/maintenance')({
  // 仅作为前端 UI 拦截优化：API 在每次调用时均会重新校验角色权限。
  beforeLoad: ({ context }) => {
    if (context.app.session.role !== 'admin') {
      throw redirect({ to: '/', search: {} });
    }
  },
  component: MaintenanceAdminView,
});
