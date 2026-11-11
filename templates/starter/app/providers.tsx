'use client';

import type { ReactNode } from 'react';
import { KelayProvider } from '@kelay/sdk/react';
import { kelay } from '@/lib/kelay';

export function Providers({ children }: { children: ReactNode }) {
  return <KelayProvider client={kelay}>{children}</KelayProvider>;
}
