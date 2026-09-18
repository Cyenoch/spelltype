import { createFileRoute } from '@tanstack/solid-router';
import { ProfileView } from '../features/profile/profile-view';

export const Route = createFileRoute('/_authenticated/me')({ component: ProfileRoute });

function ProfileRoute() {
  const context = Route.useRouteContext();
  return <ProfileView ctx={context().app} />;
}
