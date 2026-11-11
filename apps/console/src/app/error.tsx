'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <div className="card auth-card">
        <div className="empty">
          <b>Something went wrong</b>
          <div style={{ margin: '6px 0 14px' }}>The console couldn’t load this page. If it keeps happening, check that the Control API is running.</div>
          <button type="button" className="btn sm" onClick={reset}>Try again</button>
        </div>
      </div>
    </main>
  );
}
