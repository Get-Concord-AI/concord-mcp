import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Whack-a-Mole × Concord',
  description: 'Built live by two agents coordinating through Concord.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
