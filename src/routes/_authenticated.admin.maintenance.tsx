import { createFileRoute, redirect } from '@tanstack/solid-router';
import { MaintenanceAdminView } from '../features/admin/maintenance-view';

export const Route = createFileRoute('/_authenticated/admin/maintenance')({
  // UI courtesy only: the API re-checks the role on every call.
  beforeLoad: ({ context }) => {
    if (context.app.session.role !== 'admin') {
      throw redirect({ to: '/', search: {} });
    }
  },
  component: MaintenanceAdminView,
});
