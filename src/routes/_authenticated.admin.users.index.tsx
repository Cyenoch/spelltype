import { createFileRoute } from '@tanstack/solid-router';
import { AdminUsersView } from '../features/admin/users-view';
import { adminListSearch } from '../features/admin/search';
export const Route = createFileRoute('/_authenticated/admin/users/')({
  validateSearch: adminListSearch,
  component: UsersPage,
});
function UsersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminUsersView
      search={search}
      onSearch={(updates) =>
        void navigate({ search: (previous) => ({ ...previous, ...updates }), resetScroll: false })
      }
    />
  );
}
