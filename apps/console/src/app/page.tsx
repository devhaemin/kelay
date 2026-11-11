import Link from 'next/link';
import { AppCard } from '@/components/app-card';
import { PromptForm } from '@/components/home/prompt-form';
import { TopBar } from '@/components/top-bar';
import { Icon } from '@/components/ui';
import { getConsoleApi } from '@/lib/api/server';

export default async function HomePage() {
  const api = await getConsoleApi();
  const [me, apps] = await Promise.all([api.getMe(), api.listApps()]);
  const now = Date.now();

  return (
    <div className="home">
      <TopBar active="home" me={me} signedIn={api.mode === 'http'} />
      <main>
        <section className="hero">
          <Link className="announce" href="/graph">
            <span className="pill blue">New</span> App Graph — connect your apps over MCP &amp; A2A <Icon name="arrow" size={13} />
          </Link>
          <h1>
            Build agent apps
            <br />
            <span className="grad">that improve themselves</span>
          </h1>
          <p>Describe it in a paragraph. Kelay builds it, ships it with a link, and keeps improving it from your users’ feedback.</p>
          <PromptForm />
        </section>
        {apps.length > 0 && (
          <section className="home-recent" aria-labelledby="continue-building">
            <div className="home-recent-card">
              <div className="section-head">
                <h2 id="continue-building">Continue building</h2>
                <Link href="/apps" className="btn sm">View all apps</Link>
              </div>
              <div className="grid">
                {apps.slice(0, 3).map((a) => <AppCard key={a.id} app={a} now={now} />)}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
