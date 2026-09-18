import { createFileRoute } from '@tanstack/solid-router';
import { CreateRoomView } from '../features/rooms/create/create-view';

export const Route = createFileRoute('/_authenticated/create')({ component: CreateRoute });

function CreateRoute() {
  const context = Route.useRouteContext();
  return <CreateRoomView ctx={context().app} />;
}
