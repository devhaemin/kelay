import clsx from 'clsx';
import Link from 'next/link';
import type { Builder } from '@/lib/api/types';
import { AvatarMenu } from './avatar-menu';

const NAV = [
  { key: 'home', href: '/', label: 'Build' },
  { key: 'apps', href: '/apps', label: 'My Apps' },
  { key: 'graph', href: '/graph', label: 'App Graph' },
] as const;

export function TopBar({ active, me, signedIn }: { active: 'home' | 'apps' | 'graph'; me: Builder; signedIn: boolean }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">Kelay</Link>
      <nav className="topnav" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.key} href={n.href} className={clsx(active === n.key && 'active')} aria-current={active === n.key ? 'page' : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="spacer" />
      <button type="button" className="btn ghost sm">Upgrade</button>
      <AvatarMenu me={me} signedIn={signedIn} />
    </header>
  );
}
