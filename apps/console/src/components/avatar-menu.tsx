'use client';

import { DropdownMenu } from 'radix-ui';
import { signOutAction } from '@/app/actions';
import type { Builder } from '@/lib/api/types';
import { initials } from '@/lib/format';
import { useUiPrefs } from './providers';
import { Icon } from './ui';

export function AvatarMenu({ me, signedIn }: { me: Builder; signedIn: boolean }) {
  const { story, setStory } = useUiPrefs();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="avatar" aria-label={`Account: ${me.name}`}>
        {initials(me.name)}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={8}>
          <DropdownMenu.Label className="menu-label">
            {me.name}
            {me.email && <span style={{ display: 'block', marginTop: 2, textTransform: 'none', letterSpacing: 0 }}>{me.email}</span>}
          </DropdownMenu.Label>
          <DropdownMenu.CheckboxItem className="menu-item" checked={story} onCheckedChange={setStory}>
            <span style={{ flex: 1 }}>Story mode</span>
            <DropdownMenu.ItemIndicator><Icon name="check" size={14} /></DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          {signedIn && (
            <>
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.Item className="menu-item" onSelect={() => void signOutAction()}>Sign out</DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
