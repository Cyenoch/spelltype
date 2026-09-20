import { createFileRoute } from '@tanstack/solid-router';
import { AdminBooksView } from '../features/admin/books-view';
import { adminListSearch } from '../features/admin/search';
export const Route = createFileRoute('/_authenticated/admin/books/')({
  validateSearch: adminListSearch,
  component: BooksPage,
});
function BooksPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminBooksView
      search={search}
      onSearch={(updates) =>
        void navigate({ search: (previous) => ({ ...previous, ...updates }), resetScroll: false })
      }
    />
  );
}
