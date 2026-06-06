import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google';

// Self-hosted via next/font (replaces the render-blocking Google Fonts @import
// that used to sit at the top of globals.css). Each family exposes a CSS
// variable consumed by tailwind.config.ts `fontFamily`. Weights mirror the old
// import: Inter 400-700, Space Grotesk 500-700, JetBrains Mono 400-600.

export const fontSans = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});

export const fontDisplay = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
  variable: '--font-display',
});

export const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-mono',
});

/** Combined font-variable className for the `<html>` element. */
export const fontVariables = `${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`;
