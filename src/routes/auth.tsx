import { createFileRoute } from '@tanstack/solid-router';
import { AuthView } from '../features/auth/auth-view';

export const Route = createFileRoute('/auth')({ component: AuthRoute });

function AuthRoute() {
  const context = Route.useRouteContext();
  const search = Route.useSearch();
  return <AuthView ctx={context().app} error={search().error} notice={context().notice()} />;
}
