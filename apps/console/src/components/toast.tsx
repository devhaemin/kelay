'use client';

import clsx from 'clsx';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui';

type Notify = (message: string) => void;

const ToastContext = createContext<Notify>(() => {});

export const useToast = (): Notify => useContext(ToastContext);

/** The prototype's single bottom-center toast: a new message replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const notify = useCallback<Notify>((m) => {
    setMessage(m);
    setShown(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), 2200);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className={clsx('toast', shown && 'show')} role="status" aria-live="polite">
        {message && (
          <>
            <Icon name="check" />
            {message}
          </>
        )}
      </div>
    </ToastContext.Provider>
  );
}
