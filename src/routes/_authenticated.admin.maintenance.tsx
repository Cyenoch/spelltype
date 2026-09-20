import { createFileRoute } from '@tanstack/solid-router';
import { MaintenanceAdminView } from '../features/admin/maintenance-view';

export const Route = createFileRoute('/_authenticated/admin/maintenance')({
  component: MaintenanceAdminView,
});
