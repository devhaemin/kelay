'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { QUICK_LINKS, SCENES, parseRoute, sceneIndex } from '@/lib/story';
import { useUiPrefs } from './providers';
import { Icon } from './ui';

/** Story captions and the scene bar. Off unless Story mode is on (`?story=1` or the avatar menu). */
export function StoryLayer() {
  const pathname = usePathname();
  const params = useSearchParams();
  const { story, setStory, captions, setCaptions } = useUiPrefs();
  const flag = params.get('story');

  useEffect(() => {
    if (flag === '1') setStory(true);
    else if (flag === '0') setStory(false);
  }, [flag, setStory]);

  if (!story) return null;
  const route = parseRoute(pathname);
  const si = sceneIndex(route);
  const scene = si >= 0 ? SCENES[si] : undefined;
  const current = route.name === 'app' ? route.tab : route.name;
  const prev = SCENES[si - 1];
  const next = SCENES[si + 1];

  return (
    <>
      {scene && captions && (
        <aside className="story" aria-label="Story caption">
          <div className="k">
            Scene {si + 1} of {SCENES.length}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn sm ghost" style={{ height: 22, padding: '0 4px' }} onClick={() => setCaptions(false)} aria-label="Hide caption">
              <Icon name="x" size={14} />
            </button>
          </div>
          <h4>{scene.title}</h4>
          <div className="line"><span className="need">NEED</span><span>{scene.need}</span></div>
          <div className="line"><span className="ans">KELAY</span><span>{scene.answer}</span></div>
          <div className="story-nav">
            {si > 0 && prev && <Link className="btn sm" href={prev.href}><Icon name="left" size={13} /> {prev.title}</Link>}
            <span style={{ flex: 1 }} />
            {next && <Link className="btn sm primary" href={next.href}>{next.title} <Icon name="right" size={13} /></Link>}
          </div>
        </aside>
      )}
      <nav className="proto" aria-label="Story scenes">
        <span>Story</span>
        {SCENES.map((s, i) => (
          <Link key={s.key} href={s.href} className={clsx(si === i && 'on')} aria-current={si === i ? 'step' : undefined}>
            {i + 1} {s.title}
          </Link>
        ))}
        <span>·</span>
        {QUICK_LINKS.map((l) => (
          <Link key={l.key} href={l.href} className={clsx(si < 0 && current === l.key && 'on')}>{l.label}</Link>
        ))}
        {!captions && <button type="button" className="proto-btn" onClick={() => setCaptions(true)}>Notes</button>}
        <button type="button" className="proto-btn" onClick={() => setStory(false)}>Exit story</button>
      </nav>
    </>
  );
}
