import { createFileRoute } from '@tanstack/solid-router';
import { AdminMatchDetailView } from '../features/admin/match-detail-view';
export const Route = createFileRoute('/_authenticated/admin/matches/$matchId')({
  component: MatchPage,
});
function MatchPage() {
  const params = Route.useParams();
  return <AdminMatchDetailView matchId={() => params().matchId} />;
}
