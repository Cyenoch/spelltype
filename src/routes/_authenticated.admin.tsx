import { createFileRoute, redirect } from '@tanstack/solid-router';
import { AdminLayout } from '../features/admin/admin-layout';
export const Route = createFileRoute('/_authenticated/admin')({
  beforeLoad: ({ context }) => {
    if (context.app.session.role !== 'admin') throw redirect({ to: '/', search: {} });
  },
  component: AdminLayout,
});
