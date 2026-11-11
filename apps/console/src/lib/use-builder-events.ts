'use client';

import { useEffect, useState } from 'react';
import { EVENT_TYPES, mergeEvents, type BuilderEvent } from './builder';

/**
 * A workspace's transcript, kept current from the console's event stream. `app` is null until there
 * is a workspace to follow. The browser's EventSource reconnects by itself and resumes after the last
 * event it saw.
 */
export function useBuilderEvents(app: string | null, initial: BuilderEvent[]): BuilderEvent[] {
  const [events, setEvents] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setEvents((known) => mergeEvents(known, initial));
  }

  useEffect(() => {
    if (!app || typeof EventSource === 'undefined') return;
    const after = initial.at(-1)?.id ?? 0;
    const source = new EventSource(`/api/builder/workspaces/${encodeURIComponent(app)}/events?after=${after}`);
    const onEvent = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as BuilderEvent;
        setEvents((known) => mergeEvents(known, [event]));
      } catch {
        // Not one of ours; the next event still arrives.
      }
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, onEvent);
    return () => source.close();
    // The stream is opened once per app; `initial` only seeds where it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app]);

  return events;
}
