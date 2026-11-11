import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page">
      <div className="card auth-card">
        <div className="empty">
          <b>Not found</b>
          <div style={{ margin: '6px 0 14px' }}>This app or page doesn’t exist, or you don’t have access to it.</div>
          <Link className="btn sm" href="/apps">Back to My Apps</Link>
        </div>
      </div>
    </main>
  );
}
