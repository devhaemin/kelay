'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { useRef, useState } from 'react';
import { removeMemberAction, sendRecoveryAction, updateMemberAction } from '@/app/actions';
import type { AppSummary, Member, MemberPatch, Provider } from '@/lib/api/types';
import { formatAgo, formatDate } from '@/lib/format';
import { useServerState } from '@/lib/use-server-state';
import { useToast } from '../../toast';
import { Avatar, Icon } from '../../ui';

type Filter = 'all' | 'active' | 'unconfirmed' | 'admin' | 'banned';

const PLANS = ['free', 'team', 'pro'];

const PROVIDERS: Record<Provider, [string, string]> = {
  google: ['G', '#4285f4'],
  email: ['@', '#6f6d67'],
  kakao: ['K', '#e0c000'],
  github: ['GH', '#24292e'],
};

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const matches = (u: Member, f: Filter): boolean => f === 'all' || (f === 'admin' ? u.role === 'admin' : u.status === f);

function ProviderBadge({ provider }: { provider: Provider | null }) {
  if (!provider) return <span className="muted">—</span>;
  const [mark, color] = PROVIDERS[provider];
  return (
    <span className="prov">
      <i style={{ background: color }} aria-hidden="true">{mark}</i>
      {titleCase(provider)}
    </span>
  );
}

function StatusBadge({ status }: { status: Member['status'] }) {
  if (status === 'active') return <span className="pill green">Active</span>;
  if (status === 'banned') return <span className="pill red">Banned</span>;
  return <span className="pill amber">Unconfirmed</span>;
}

export default function UsersTab({
  app,
  members: membersProp,
  roles,
  team,
  now,
}: {
  app: AppSummary;
  members: Member[];
  /** Roles the app's schema declares. */
  roles: string[];
  team: string;
  /** The moment "2 min ago" is measured from. */
  now: number;
}) {
  const notify = useToast();
  const [all, setMembers] = useServerState(membersProp);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastOpened = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const count = (f: Filter) => all.filter((u) => matches(u, f)).length;
  const q = query.trim().toLowerCase();
  const rows = all.filter(
    (u) => matches(u, filter) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q)),
  );
  const open = all.find((u) => u.userId === openId) ?? null;
  const total = Math.max(all.length, app.users);

  const filters: [Filter, string][] = [['all', 'All users'], ['active', 'Active'], ['unconfirmed', 'Unconfirmed'], ['admin', 'Admins']];
  if (count('banned') > 0 || filter === 'banned') filters.push(['banned', 'Banned']);

  const openUser = (id: string) => {
    lastOpened.current = id;
    setOpenId(id);
  };

  const patch = async (u: Member, change: MemberPatch, message: string) => {
    const res = await updateMemberAction(app.id, u.userId, change);
    if (!res.ok) return notify(res.error);
    // The update answers with the stored row; the profile and connections stay as listed.
    setMembers((list) => list.map((m) => (m.userId === u.userId ? { ...m, role: res.data.role, plan: res.data.plan, status: res.data.status } : m)));
    notify(message);
  };

  const remove = async (u: Member) => {
    const res = await removeMemberAction(app.id, u.userId);
    if (!res.ok) return notify(res.error);
    setMembers((list) => list.filter((m) => m.userId !== u.userId));
    setOpenId(null);
    notify(`${u.name} removed from ${team || app.name}`);
  };

  const recover = async (u: Member) => {
    const res = await sendRecoveryAction(app.id, u.userId);
    notify(res.ok ? `Password recovery sent to ${u.email || u.name}` : res.error);
  };

  return (
    <div className="users-layout">
      <nav className="side-list" aria-label="Users">
        <div className="label">Users</div>
        {filters.map(([k, label]) => (
          <button key={k} type="button" className={clsx(filter === k && 'on')} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
            <span className="muted">{count(k)}</span>
          </button>
        ))}
        <div className="label">Configuration</div>
        <button type="button" onClick={() => notify('Sign-in providers are not available in this preview')}>Sign-in providers</button>
        <Link href={`/app/${app.id}/access`}>Access rules</Link>
        <button type="button" onClick={() => notify('Email templates are not available in this preview')}>Email templates</button>
      </nav>
      <div>
        <div className="toolbar">
          <label className="search" style={{ flex: 1, maxWidth: 360 }}>
            <Icon name="search" size={14} />
            <span className="sr-only">Search users</span>
            <input ref={searchRef} placeholder="Search by name, email or UID" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <span className="small muted"><Icon name="user" size={12} /> One Kelay ID per person, across all your apps</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn sm primary" onClick={() => notify('Invites are not available in this preview')}>
            <Icon name="plus" size={14} /> Invite
          </button>
        </div>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Provider</th>
                <th scope="col">AI assistant</th><th scope="col">Last sign in</th><th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.userId} style={{ cursor: 'pointer' }} onClick={() => openUser(u.userId)}>
                  <td>
                    {/* The row's click handler opens the drawer; the button makes the row reachable by keyboard. */}
                    <button
                      type="button"
                      className="linkbtn"
                      aria-haspopup="dialog"
                      aria-expanded={openId === u.userId}
                      aria-label={`${u.name}, user details`}
                      ref={(el) => {
                        if (el) rowButtons.current.set(u.userId, el);
                        else rowButtons.current.delete(u.userId);
                      }}
                    >
                      <Avatar id={u.userId} name={u.name} color={u.color} /> {u.name}
                    </button>
                  </td>
                  <td className="muted">{u.email || '—'}</td>
                  <td>{titleCase(u.role)}</td>
                  <td><ProviderBadge provider={u.provider} /></td>
                  <td>{u.assistant ?? <span className="muted">—</span>}</td>
                  <td className="muted">{formatAgo(u.lastSignInAt, now)}</td>
                  <td><StatusBadge status={u.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">{q ? `No users match “${query.trim()}”.` : 'No users here yet.'}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="small muted" style={{ marginTop: 10 }} role="status">
          Showing {rows.length} of {total} members{team ? ` · ${team}` : ''}
        </div>
      </div>

      <Dialog.Root open={open !== null} onOpenChange={(o) => !o && setOpenId(null)} modal={false}>
        <Dialog.Portal>
          <Dialog.Content
            className="drawer open"
            aria-describedby={undefined}
            // Non-modal like the prototype: clicking another row swaps the drawer's user.
            onInteractOutside={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const back = lastOpened.current ? rowButtons.current.get(lastOpened.current) : undefined;
              (back ?? searchRef.current)?.focus();
            }}
          >
            {open && (
              <UserDetails
                key={open.userId}
                app={app}
                user={open}
                roles={roles}
                now={now}
                onPatch={(change, message) => patch(open, change, message)}
                onRecover={() => recover(open)}
                onRemove={() => remove(open)}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function UserDetails({
  app,
  user: u,
  roles,
  now,
  onPatch,
  onRecover,
  onRemove,
}: {
  app: AppSummary;
  user: Member;
  roles: string[];
  now: number;
  onPatch: (change: MemberPatch, message: string) => void;
  onRecover: () => void;
  onRemove: () => void;
}) {
  const [editingRole, setEditingRole] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const banned = u.status === 'banned';
  const plans = PLANS.includes(u.plan) ? PLANS : [u.plan, ...PLANS];

  return (
    <>
      <div className="card-head">
        <Dialog.Title asChild><h3>User details</h3></Dialog.Title>
        <span className="spacer" />
        <Dialog.Close className="btn sm ghost" aria-label="Close user details"><Icon name="x" /></Dialog.Close>
      </div>
      <div className="drawer-body">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Avatar id={u.userId} name={u.name} color={u.color} size={44} />
          <div>
            <b>{u.name}</b>
            <div className="small muted">{u.email}</div>
          </div>
        </div>
        <div>
          <h4>Account</h4>
          <dl className="kv">
            <dt>Role</dt><dd>{titleCase(u.role)}</dd>
            <dt>Plan</dt><dd>{titleCase(u.plan)}</dd>
            <dt>Status</dt><dd><StatusBadge status={u.status} /></dd>
            <dt>Provider</dt><dd><ProviderBadge provider={u.provider} /></dd>
            <dt>Created</dt><dd>{u.createdAt ? formatDate(u.createdAt) : '—'}</dd>
            <dt>Last sign in</dt><dd>{formatAgo(u.lastSignInAt, now)}</dd>
            <dt>UID</dt><dd className="mono">{u.userId}</dd>
          </dl>
        </div>
        <div>
          <h4>Kelay ID</h4>
          <dl className="kv">
            <dt>{app.name}</dt><dd>{titleCase(u.role)}</dd>
            {u.otherApps.map((o) => (
              <FragmentRow key={o.app} term={o.name} value={titleCase(o.role)} />
            ))}
          </dl>
        </div>
        <div>
          <h4>AI assistant</h4>
          <dl className="kv">
            <dt>{app.name}</dt><dd>{u.assistant ? `${u.assistant} · over MCP` : 'Not connected'}</dd>
            <dt>Runs as</dt><dd>{u.assistant ? 'Their Kelay ID · same access rules' : '—'}</dd>
          </dl>
        </div>
        <div>
          <h4>Actions</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {editingRole ? (
              <label className="field">
                Role
                <select
                  className="select"
                  autoFocus
                  value={u.role}
                  onChange={(e) => {
                    onPatch({ role: e.target.value }, `${u.name} is now ${titleCase(e.target.value)}`);
                    setEditingRole(false);
                  }}
                  onBlur={() => setEditingRole(false)}
                >
                  {(roles.includes(u.role) ? roles : [u.role, ...roles]).map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
                </select>
              </label>
            ) : (
              <button type="button" className="btn sm" onClick={() => setEditingRole(true)}>Change role</button>
            )}
            <label className="field">
              Plan
              <select className="select" value={u.plan} onChange={(e) => onPatch({ plan: e.target.value }, `${u.name} moved to the ${titleCase(e.target.value)} plan`)}>
                {plans.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}
              </select>
            </label>
            <button type="button" className="btn sm" onClick={onRecover}>Send password recovery</button>
            <button
              type="button"
              className="btn sm"
              onClick={() => (banned ? onPatch({ status: 'active' }, `${u.name} can sign in again`) : onPatch({ status: 'banned' }, `${u.name} is banned from ${app.name}`))}
            >
              {banned ? 'Unban user' : 'Ban user'}
            </button>
            {confirmRemove ? (
              <div role="group" aria-label={`Remove ${u.name} from team?`} style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn sm" style={{ flex: 1, color: 'var(--red)' }} autoFocus onClick={onRemove}>Yes, remove {u.name.split(' ')[0]}</button>
                <button type="button" className="btn sm" style={{ flex: 1 }} onClick={() => setConfirmRemove(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="btn sm" style={{ color: 'var(--red)' }} onClick={() => setConfirmRemove(true)}>Remove from team</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function FragmentRow({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}
