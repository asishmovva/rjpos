import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RJ POS',
  description: 'Retail operations portal',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
