'use client';

import { DropdownMenu } from 'radix-ui';
import { useRef } from 'react';
import type { Builder } from '@/lib/api/types';
import { initials } from '@/lib/format';
import { useUiPrefs } from './providers';
import { Icon } from './ui';

export function AvatarMenu({ me, signedIn }: { me: Builder; signedIn: boolean }) {
  const { story, setStory } = useUiPrefs();
  const signOut = useRef<HTMLFormElement>(null);
  return (
    <>
      {/* Outside the menu, which unmounts when it closes. /auth/signout ends the Kelay ID session as well. */}
      {signedIn && <form ref={signOut} method="post" action="/auth/signout" hidden />}
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
                <DropdownMenu.Item className="menu-item" onSelect={() => signOut.current?.requestSubmit()}>Sign out</DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
