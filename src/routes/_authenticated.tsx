import { createFileRoute, redirect } from '@tanstack/solid-router';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context }) => {
    if (!context.app.session.user) {
      throw redirect({ to: '/auth', search: { room: context.app.pendingInvite() ?? undefined } });
    }
  },
});
