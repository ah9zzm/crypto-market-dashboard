import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Crypto Market Dashboard',
  description: 'Exchange-by-exchange crypto market comparison dashboard',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
