import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RJ POS',
  description: 'Retail register and merchant operations',
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
