import { useEffect, useRef, type RefObject } from 'react';

/** Closes a popover on a press outside `root`, or on Escape, while it is open. */
export function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const handle = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', handle);
    document.addEventListener('keydown', handle);
    return () => {
      document.removeEventListener('pointerdown', handle);
      document.removeEventListener('keydown', handle);
    };
  }, [open, root]);
}
