import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Providers } from '@/components/providers';
import { StoryLayer } from '@/components/story-layer';
import { STORY_COOKIE } from '@/lib/story';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Kelay', template: '%s · Kelay' },
  description: 'Build agent apps that improve themselves.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const story = (await cookies()).get(STORY_COOKIE)?.value === '1';
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <Providers initialStory={story}>
          {children}
          <Suspense fallback={null}>
            <StoryLayer />
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}
