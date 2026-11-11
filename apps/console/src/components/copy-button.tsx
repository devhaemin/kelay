'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './ui';

export function CopyButton({ value, label = 'Copy', className, plain, style }: { value: string; label?: string; className?: string; plain?: boolean; style?: CSSProperties }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard can be unavailable (permissions, insecure origin); the value stays visible to copy by hand.
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button type="button" className={clsx('btn sm', !copied && !plain && 'primary', className)} style={style} onClick={copy}>
      {!plain && <Icon name={copied ? 'check' : 'link'} size={13} />} {copied ? 'Copied' : label}
    </button>
  );
}

export function CopyField({ value, display, children }: { value: string; display?: string; children?: ReactNode }) {
  return (
    <div className="copy-field">
      <span className="muted"><Icon name="globe" size={14} /></span>
      <span className="v">{children ?? display ?? value}</span>
      <CopyButton value={value} />
    </div>
  );
}
