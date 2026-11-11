'use client';

import type { AppDetail, AppSummary, Builder } from '@/lib/api/types';
import { CopyField } from './copy-button';
import { CloseButton, DialogTitle, Modal } from './dialogs';
import { AppIcon, Icon } from './ui';

const bare = (url: string) => url.replace(/^https?:\/\//, '');

export function ShareStoreModal({ open, onOpenChange, me, apps }: { open: boolean; onOpenChange: (o: boolean) => void; me: Builder; apps: AppSummary[] }) {
  const url = `https://kelay.app/${me.handle}`;
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <div className="modal-head">
        <DialogTitle asChild><h3>Share your store page</h3></DialogTitle>
        <span className="spacer" />
        <CloseButton />
      </div>
      <div className="modal-sec">
        <div className="muted" style={{ marginBottom: 12, lineHeight: 1.5 }}>
          One page with all of your <b>live</b> apps. Drafts stay hidden.
        </div>
        <CopyField value={url} />
      </div>
      <div className="modal-sec">
        <div className="sec-label">Shown on the page</div>
        {apps.map((a) => (
          <div className="person" key={a.id}>
            <AppIcon emoji={a.emoji} color={a.color} size={30} />
            <div style={{ flex: 1 }}>
              <div>{a.name}</div>
              <div className="small muted">{a.users} users</div>
            </div>
            {a.status === 'live' ? <span className="pill green">Listed</span> : <span className="pill">Hidden · {a.status}</span>}
          </div>
        ))}
      </div>
      <div className="modal-foot">
        <a className="btn sm ghost" href={url} target="_blank" rel="noopener noreferrer"><Icon name="ext" size={13} /> Preview page</a>
        <span className="spacer" />
        <button type="button" className="btn sm primary" onClick={() => onOpenChange(false)}>Done</button>
      </div>
    </Modal>
  );
}

export function ShareAppModal({ open, onOpenChange, app }: { open: boolean; onOpenChange: (o: boolean) => void; app: AppDetail }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width={480}>
      <div className="modal-head">
        <AppIcon emoji={app.emoji} color={app.color} size={30} />
        <DialogTitle asChild><h3>Share {app.name}</h3></DialogTitle>
        <span className="spacer" />
        <CloseButton />
      </div>
      <div className="modal-sec">
        <div className="muted" style={{ marginBottom: 12 }}>Anyone with this link can sign in and use the app.</div>
        <CopyField value={app.productionUrl} display={bare(app.productionUrl)} />
      </div>
      <div className="modal-foot">
        <span className="small muted"><Icon name="rocket" size={13} /> Shares the Production version</span>
        <span className="spacer" />
        <a className="btn sm ghost" href={app.productionUrl} target="_blank" rel="noopener noreferrer"><Icon name="ext" size={13} /> Open</a>
      </div>
    </Modal>
  );
}
