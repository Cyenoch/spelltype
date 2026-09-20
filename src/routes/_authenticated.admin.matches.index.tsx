import { createFileRoute } from '@tanstack/solid-router';
import { AdminMatchesView } from '../features/admin/matches-view';
import { adminMatchSearch, parseMatchPhase } from '../features/admin/search';
export const Route = createFileRoute('/_authenticated/admin/matches/')({
  validateSearch: adminMatchSearch,
  component: MatchesPage,
});
function MatchesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AdminMatchesView
      search={search}
      onSearch={(updates) =>
        void navigate({
          search: (previous) => ({
            ...previous,
            ...updates,
            phase: parseMatchPhase(updates.phase ?? previous.phase),
          }),
          resetScroll: false,
        })
      }
    />
  );
}
