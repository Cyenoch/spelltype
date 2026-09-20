import { createFileRoute } from '@tanstack/solid-router';
import { AdminOverviewView } from '../features/admin/overview-view';
export const Route = createFileRoute('/_authenticated/admin/')({ component: AdminOverviewView });
