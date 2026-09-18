import { createFileRoute } from '@tanstack/solid-router';
import { GuideView } from '../features/guide/guide-view';

export const Route = createFileRoute('/guide')({ component: GuideView });
