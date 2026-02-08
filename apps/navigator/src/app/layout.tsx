import { BetterStackWebVitals } from "@logtail/next/webVitals";
import {
  GeistPixelCircle,
  GeistPixelGrid,
  GeistPixelLine,
  GeistPixelSquare,
  GeistPixelTriangle,
} from "geist/font/pixel";
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const neueMontreal = localFont({
  src: "./fonts/PPNeueMontreal-Regular.woff2",
  variable: "--font-neue-montreal",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Detent Navigator",
    template: "%s | Detent",
  },
  description:
    "Authenticate and manage your Detent CLI sessions. Securely connect your development environment to Detent services.",
  applicationName: "Detent Navigator",
  keywords: ["detent", "cli", "authentication", "developer tools"],
  authors: [{ name: "Detent" }],
  creator: "Detent",
  openGraph: {
    type: "website",
    siteName: "Detent Navigator",
    title: "Detent Navigator",
    description:
      "Authenticate and manage your Detent CLI sessions. Securely connect your development environment to Detent services.",
  },
  twitter: {
    card: "summary",
    title: "Detent Navigator",
    description:
      "Authenticate and manage your Detent CLI sessions. Securely connect your development environment to Detent services.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${neueMontreal.variable} ${GeistPixelSquare.variable} ${GeistPixelGrid.variable} ${GeistPixelCircle.variable} ${GeistPixelTriangle.variable} ${GeistPixelLine.variable} antialiased`}
      >
        <BetterStackWebVitals />
        {children}
      </body>
    </html>
  );
}
