import type { Metadata, Viewport } from "next";
import { Mulish, Geist_Mono } from "next/font/google";
import "./globals.css";

const mulish = Mulish({
  variable: "--font-mulish",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Inventory Dashboard",
  description: "Yubisayu Inventory Management",
};

// Lock the zoom level. iOS Safari otherwise auto-zooms when a sub-16px input
// is focused (keyboard pop-out), and won't zoom back out. maximumScale=1 +
// userScalable=false stops that. Trade-off: it also disables pinch-to-zoom —
// acceptable for an internal admin tool, but note the accessibility cost.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${mulish.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
