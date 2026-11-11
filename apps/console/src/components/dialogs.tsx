'use client';

import { Dialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { Icon } from './ui';

export const DialogTitle = Dialog.Title;

/** Centered modal: the overlay is the grid that centers it, as in the prototype's `.modal-bg`. */
export function Modal({
  open,
  onOpenChange,
  width,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-bg">
          <Dialog.Content className="modal" style={width ? { width } : undefined} aria-describedby={undefined}>
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CloseButton({ label = 'Close' }: { label?: string }) {
  return (
    <Dialog.Close className="btn sm ghost" aria-label={label}>
      <Icon name="x" />
    </Dialog.Close>
  );
}

/**
 * Side drawer. Non-modal like the prototype: the page stays usable, so picking another row
 * swaps the drawer's content instead of closing it.
 */
export function Drawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dialog.Portal>
        <Dialog.Content className="drawer open" aria-describedby={undefined} onInteractOutside={(e) => e.preventDefault()}>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
