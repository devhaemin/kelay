'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '@/lib/action-result';
import type { AppDetail, DeployResult } from '@/lib/api/types';
import { CopyField } from '../../copy-button';
import { CloseButton, DialogTitle, Modal } from '../../dialogs';
import { AppIcon, Icon } from '../../ui';

const STEP_MS = 650;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deploy to production: animates the steps while the publish call runs, then hands back the link. */
export function ShipModal({
  app,
  closeHref,
  team,
  ruleCount,
  checkCount,
  onPublish,
}: {
  app: AppDetail;
  closeHref: string;
  team: string;
  ruleCount: number | null;
  checkCount: number | null;
  onPublish: () => Promise<ActionResult<DeployResult>>;
}) {
  const router = useRouter();
  const steps = [
    'Build the production version',
    ruleCount ? `Apply ${ruleCount} access rules` : 'Apply access rules',
    checkCount ? `Run ${checkCount} interaction checks` : 'Run interaction checks',
    'Go live',
  ];
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const nextVersion = app.version ? `v${Number(app.version.replace(/^v/, '')) + 1}` : 'v1';

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const publishing = onPublish();
    void (async () => {
      for (let i = 1; i < steps.length; i++) {
        await wait(STEP_MS);
        setStep(i);
      }
      const r = await publishing;
      await wait(STEP_MS);
      if (!r.ok) return setError(r.error);
      setResult(r.data);
      setStep(steps.length);
    })();
  }, [onPublish, steps.length]);

  const done = result !== null;
  const url = result?.url ?? app.productionUrl;

  return (
    <Modal open onOpenChange={(o) => !o && router.push(closeHref)} width={480}>
      <div className="modal-head">
        <AppIcon emoji={app.emoji} color={app.color} size={30} />
        <DialogTitle asChild><h3>{done ? `${app.name} is live` : `Shipping ${app.name}…`}</h3></DialogTitle>
        <span className="spacer" />
        <CloseButton />
      </div>
      <div className="modal-sec" aria-live="polite">
        {steps.map((t, i) => {
          const failed = error !== null && i === step;
          return (
            <div key={t} className={`ship-step ${i > step ? 'wait' : ''}`}>
              {failed ? <span className="st-ic bad"><Icon name="x" size={12} /></span>
                : i < step ? <span className="st-ic ok"><Icon name="check" size={12} /></span>
                : i === step ? <span className="spinner" style={{ margin: '0 4px' }} aria-hidden="true" />
                : <span className="st-ic wait"><Icon name="chev" size={12} /></span>}{' '}
              {t}
            </div>
          );
        })}
        {error && <div className="error-text" role="alert" style={{ marginTop: 6 }}>{error}</div>}
      </div>
      {done && (
        <div className="modal-sec">
          <div className="sec-label">Share this link with {team || 'your team'}</div>
          <CopyField value={url} display={url.replace(/^https?:\/\//, '')} />
          <div className="small muted" style={{ marginTop: 10 }}>People sign in once with Kelay ID. Your access rules decide what each of them sees.</div>
        </div>
      )}
      <div className="modal-foot">
        <span className="small muted">
          <Icon name="rocket" size={13} /> {result?.version ?? nextVersion} · {done ? `live in ${Math.round(result.durationMs / 1000)}s` : 'usually under 30s'}
        </span>
        <span className="spacer" />
        {done && <Link className="btn sm primary" href={closeHref}>Done</Link>}
      </div>
    </Modal>
  );
}
