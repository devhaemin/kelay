'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { STORY_COOKIE } from '@/lib/story';
import { ToastProvider } from './toast';

export type Device = 'pc' | 'mobile';

interface UiPrefs {
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  device: Device;
  setDevice: (d: Device) => void;
  story: boolean;
  setStory: (on: boolean) => void;
  captions: boolean;
  setCaptions: (on: boolean) => void;
}

const noop = () => {};
const UiPrefsContext = createContext<UiPrefs>({
  chatOpen: true, setChatOpen: noop, device: 'pc', setDevice: noop,
  story: false, setStory: noop, captions: true, setCaptions: noop,
});

export const useUiPrefs = (): UiPrefs => useContext(UiPrefsContext);

/** Lives in the root layout, so these survive navigation between pages and workspace tabs. */
export function Providers({ initialStory, children }: { initialStory: boolean; children: ReactNode }) {
  const [chatOpen, setChatOpen] = useState(true);
  const [device, setDevice] = useState<Device>('pc');
  const [story, setStoryState] = useState(initialStory);
  const [captions, setCaptions] = useState(true);

  const setStory = useCallback((on: boolean) => {
    setStoryState(on);
    if (on) setCaptions(true);
    document.cookie = on ? `${STORY_COOKIE}=1; path=/; max-age=31536000; samesite=lax` : `${STORY_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }, []);

  const value = useMemo(
    () => ({ chatOpen, setChatOpen, device, setDevice, story, setStory, captions, setCaptions }),
    [chatOpen, device, story, setStory, captions],
  );

  return (
    <UiPrefsContext.Provider value={value}>
      <ToastProvider>{children}</ToastProvider>
    </UiPrefsContext.Provider>
  );
}
