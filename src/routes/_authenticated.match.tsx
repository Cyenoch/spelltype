import { createFileRoute } from '@tanstack/solid-router';
import { QueueView } from '../features/matchmaking/queue-view';

export const Route = createFileRoute('/_authenticated/match')({ component: MatchRoute });

function MatchRoute() {
  const context = Route.useRouteContext();
  return <QueueView ctx={context().app} />;
}
