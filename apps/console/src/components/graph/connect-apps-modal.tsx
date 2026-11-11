'use client';

import { useState, useTransition, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/action-result';
import { AGENTS_NODE, type AppSummary, type Grant, type GrantKind, type GrantRequest } from '@/lib/api/types';
import { CloseButton, DialogTitle, Modal } from '../dialogs';
import { Seg } from '../ui';

export function ConnectAppsModal({
  open,
  onOpenChange,
  apps,
  onRequest,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  apps: AppSummary[];
  onRequest: (input: GrantRequest) => Promise<ActionResult<Grant>>;
}) {
  const [from, setFrom] = useState(apps[0]?.id ?? '');
  const [to, setTo] = useState(apps[1]?.id ?? '');
  const [kind, setKind] = useState<GrantKind>('MCP');
  const [what, setWhat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (from === to) return setError('Pick two different apps.');
    startTransition(async () => {
      const r = await onRequest({ from, to, kind, what: what.trim() });
      if (!r.ok) return setError(r.error);
      setWhat('');
      onOpenChange(false);
    });
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} width={480}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <DialogTitle asChild><h3>Connect apps</h3></DialogTitle>
          <span className="spacer" />
          <CloseButton />
        </div>
        <div className="modal-sec" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="muted" style={{ lineHeight: 1.5 }}>
            The request shows up on the App Graph until you allow it. Calls run as the signed-in member, under the target app’s access rules.
          </div>
          <div className="field-row">
            <label className="field">
              From
              <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value={AGENTS_NODE}>Personal agents</option>
                {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label className="field">
              To
              <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
                {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          <div className="field">
            <span id="connect-protocol">Protocol</span>
            <Seg
              label="Protocol"
              value={kind}
              onChange={setKind}
              options={[{ value: 'MCP', label: 'MCP · tool call' }, { value: 'A2A', label: 'A2A · agent hand-off' }]}
            />
          </div>
          <label className="field">
            What it does
            <input className="input" required maxLength={200} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Attach documents to tickets" />
          </label>
          {error && <div className="error-text" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn sm ghost" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="submit" className="btn sm primary" disabled={busy || !what.trim()}>Request connection</button>
        </div>
      </form>
    </Modal>
  );
}
