/**
 * A simulated person's plan as presence sees it: the virtual screen's view, streamed to whoever follows
 * them. They never follow anyone themselves, so applying a frame does nothing.
 */
import type { PresenceViewport } from '../presence/session';
import type { VirtualScreen } from './screen';

export function syntheticViewport(screen: VirtualScreen): PresenceViewport {
  return {
    read: () => screen.view(),
    apply: () => 'applied',
    onChange: (listener) => screen.onChange(listener),
    onUserNavigate: () => () => undefined,
  };
}
