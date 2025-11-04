import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LAN Scanner Pro',
  description: 'Advanced browser-based LAN scanner for quick host discovery.'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
