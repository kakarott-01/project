import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'UpBot — Automated Trading',
  description: 'Personal algorithmic trading bot',
  icons: {
    // SVG icon — used by modern browsers, scales perfectly at any size
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
    // Apple touch icon — iOS home screen
    apple: [
      { url: '/apple-icon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
    shortcut: '/icon.svg',
  },
  manifest: '/manifest.json',
  // Android / PWA theme
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
    'apple-mobile-web-app-title': 'UpBot',
    'theme-color': '#030712',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Explicit link tags for maximum Android PWA compatibility.
          Next.js metadata handles <link rel="icon"> but some Android
          browsers also need explicit apple-touch-icon tags.
        */}
        <link rel="apple-touch-icon" href="/apple-icon.svg" />
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <meta name="theme-color" content="#030712" />
      </head>
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}