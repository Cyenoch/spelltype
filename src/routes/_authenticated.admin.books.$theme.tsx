import { createFileRoute } from '@tanstack/solid-router';
import { AdminBookDetailView } from '../features/admin/book-detail-view';
import { adminPageSearch } from '../features/admin/search';
export const Route = createFileRoute('/_authenticated/admin/books/$theme')({
  validateSearch: adminPageSearch,
  component: BookPage,
});
function BookPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminBookDetailView
      theme={() => params().theme}
      page={() => search().page}
      onPage={(page) => void navigate({ search: { page }, resetScroll: false })}
    />
  );
}
