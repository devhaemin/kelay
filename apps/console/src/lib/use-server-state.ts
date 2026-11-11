'use client';

import { useState } from 'react';

/**
 * Local state seeded from server props. Actions update it right away from their result; when the
 * server re-renders with fresh props (after revalidation), the props win again.
 */
export function useServerState<T>(value: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setState(value);
  }
  return [state, setState];
}
