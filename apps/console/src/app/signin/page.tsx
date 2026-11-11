import type { Metadata } from 'next';
import Link from 'next/link';
import { signInAction } from '@/app/actions';
import { dataMode } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { error } = await searchParams;
  const mock = dataMode() === 'mock';

  return (
    <main className="page">
      <div className="card auth-card">
        <div className="card-head"><h1 className="brand" style={{ margin: 0 }}>Kelay</h1></div>
        {mock ? (
          <div className="node-detail">
            <div className="muted" style={{ lineHeight: 1.5 }}>The console is running on mock data (<span className="mono">CONSOLE_DATA=mock</span>), so there is nothing to sign in to.</div>
            <Link className="btn sm primary" href="/" style={{ alignSelf: 'flex-start' }}>Open the console</Link>
          </div>
        ) : (
          <form action={signInAction} className="node-detail">
            <div className="muted" style={{ lineHeight: 1.5 }}>
              Paste a builder token from Kelay ID. It is kept in an httpOnly cookie and only sent from the console server to the Control API.
            </div>
            <label className="field">
              Builder token
              <input className="input" name="token" type="password" autoComplete="off" required minLength={16} />
            </label>
            {error && <div className="error-text" role="alert">That token doesn’t look right. Paste the whole token.</div>}
            <button type="submit" className="btn sm primary" style={{ alignSelf: 'flex-start' }}>Sign in</button>
          </form>
        )}
      </div>
    </main>
  );
}
