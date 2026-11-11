import clsx from 'clsx';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { AppStatus } from '@/lib/api/types';
import { avatarColor, initials } from '@/lib/format';
import { ICON_PATHS, type IconName } from './icon-paths';

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={clsx('icon', className)}
      viewBox="0 0 24 24"
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
      focusable="false"
      // Static, trusted markup from ICON_PATHS; never user input.
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}

export function StatusPill({ status }: { status: AppStatus }) {
  if (status === 'live') return <span className="pill green"><span className="dot" />Live</span>;
  if (status === 'draft') return <span className="pill">Draft</span>;
  return <span className="pill amber"><span className="dot" />Paused</span>;
}

export function Avatar({ id, name, color, size = 20 }: { id: string; name: string; color?: string | undefined; size?: number }) {
  return (
    <span
      className="av"
      style={{ background: color ?? avatarColor(id), width: size, height: size, fontSize: size >= 30 ? Math.round(size * 0.36) : undefined }}
      title={name}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function AppIcon({ emoji, color, size = 36 }: { emoji: string; color: string; size?: number }) {
  const style: CSSProperties = { background: color };
  if (size !== 36) Object.assign(style, { width: size, height: size, fontSize: Math.round(size / 2), borderRadius: size <= 28 ? 8 : 10 });
  return <div className="app-icon" style={style} aria-hidden="true">{emoji}</div>;
}

export function ProtoTag({ kind }: { kind: 'MCP' | 'A2A' }) {
  return <span className={clsx('proto-tag', kind.toLowerCase())}>{kind}</span>;
}

/**
 * Inline markup used by fixtures and API text: `**bold**`, `` `mono` ``, `[[ticket ref]]`,
 * `_italic_`. Everything else is rendered as text, so API strings cannot inject HTML.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]|_[^_]+_)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`')) return <span key={i} className="mono">{p.slice(1, -1)}</span>;
        if (p.startsWith('[[') && p.endsWith(']]')) return <span key={i} className="ticket-ref">{p.slice(2, -2)}</span>;
        if (p.length > 2 && p.startsWith('_') && p.endsWith('_')) return <i key={i}>{p.slice(1, -1)}</i>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: ReactNode; ariaLabel?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={clsx(value === o.value && 'on')}
          aria-pressed={value === o.value}
          aria-label={o.ariaLabel}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange?: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={clsx('switch', on && 'on')}
      onClick={() => onChange?.(!on)}
    />
  );
}
