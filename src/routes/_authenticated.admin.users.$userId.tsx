import { createFileRoute } from '@tanstack/solid-router';
import { AdminUserDetailView } from '../features/admin/user-detail-view';
import { adminPageSearch } from '../features/admin/search';
export const Route = createFileRoute('/_authenticated/admin/users/$userId')({
  validateSearch: adminPageSearch,
  component: UserPage,
});
function UserPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminUserDetailView
      userId={() => params().userId}
      page={() => search().page}
      onPage={(page) => void navigate({ search: { page }, resetScroll: false })}
    />
  );
}
