import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { dataMode } from '@/lib/api/server';
import { signedInEmail } from '@/lib/auth/kelay-id';

export const metadata: Metadata = { title: 'Sign in' };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = first(params.error);
  const mock = dataMode() === 'mock';
  // Someone who signed in at Kelay ID but is not a builder needs to see which account that was.
  const email = !mock && error === 'not_builder' ? await signedInEmail((await headers()).get('cookie')) : null;

  return (
    <main className="page">
      <div className="card auth-card">
        <div className="card-head"><h1 className="brand" style={{ margin: 0 }}>Kelay</h1></div>
        {mock ? (
          <div className="node-detail">
            <div className="muted" style={{ lineHeight: 1.5 }}>The console is running on mock data (<span className="mono">CONSOLE_DATA=mock</span>), so there is nothing to sign in to.</div>
            <Link className="btn sm primary" href="/" style={{ alignSelf: 'flex-start' }}>Open the console</Link>
          </div>
        ) : error === 'not_builder' ? (
          <div className="node-detail">
            <div className="error-text" role="alert">{email ? `${email} is signed in to Kelay ID, but is not a builder.` : 'This Kelay ID account is not a builder.'}</div>
            <div className="muted" style={{ lineHeight: 1.5 }}>Ask whoever runs this Kelay to add your email to the builders, or sign out and use another account.</div>
            <form method="post" action="/auth/signout">
              <button type="submit" className="btn sm">Sign out of Kelay ID</button>
            </form>
          </div>
        ) : (
          <div className="node-detail">
            <div className="muted" style={{ lineHeight: 1.5 }}>
              {first(params.signed_out) ? 'You are signed out.' : 'The console is for builders.'} Sign in with your Kelay ID to build and run your apps.
            </div>
            {error === 'unavailable' && <div className="error-text" role="alert">Kelay ID did not answer. Try again in a moment.</div>}
            {/* A route handler that redirects to another origin: a plain link, so the router does not prefetch it. */}
            <a className="btn sm primary" href="/auth/signin" style={{ alignSelf: 'flex-start' }}>Sign in with Kelay ID</a>
          </div>
        )}
      </div>
    </main>
  );
}
