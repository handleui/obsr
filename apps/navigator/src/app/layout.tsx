import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./providers";
import WebVitals from "./web-vitals";

// HACK: Re-declare Geist Pixel fonts locally instead of importing from
// geist/font/pixel because the package omits display:"swap", causing FOIT.
// All values must be inline literals — Next.js font loaders are statically analyzed.
const GeistPixelSquare = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Square.woff2",
  variable: "--font-geist-pixel-square",
  weight: "500",
  display: "swap",
  fallback: [
    "Geist Mono",
    "ui-monospace",
    "SFMono-Regular",
    "Roboto Mono",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Courier New",
    "monospace",
  ],
  adjustFontFallback: false,
});

const GeistPixelTriangle = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-pixel/GeistPixel-Triangle.woff2",
  variable: "--font-geist-pixel-triangle",
  weight: "500",
  display: "swap",
  fallback: [
    "Geist Mono",
    "ui-monospace",
    "SFMono-Regular",
    "Roboto Mono",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Courier New",
    "monospace",
  ],
  adjustFontFallback: false,
});

const GeistSans = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const GeistMono = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

const fontVariables = [
  GeistSans.variable,
  GeistMono.variable,
  GeistPixelSquare.variable,
  GeistPixelTriangle.variable,
].join(" ");

const META_DESCRIPTION =
  "Authenticate and manage your Detent CLI sessions. Securely connect your development environment to Detent services.";

export const metadata: Metadata = {
  title: {
    default: "Detent Navigator",
    template: "%s / Detent",
  },
  description: META_DESCRIPTION,
  applicationName: "Detent Navigator",
  keywords: ["detent", "cli", "authentication", "developer tools"],
  authors: [{ name: "Detent" }],
  creator: "Detent",
  openGraph: {
    type: "website",
    siteName: "Detent Navigator",
    title: "Detent Navigator",
    description: META_DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: "Detent Navigator",
    description: META_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => (
  <html lang="en">
    <body className={`${fontVariables} antialiased`}>
      {process.env.NODE_ENV === "development" && (
        <Script
          crossOrigin="anonymous"
          src="https://unpkg.com/react-grab@0.1.13/dist/index.global.js"
          strategy="beforeInteractive"
        />
      )}
      {process.env.NODE_ENV === "production" && <WebVitals />}
      <Providers>{children}</Providers>
    </body>
  </html>
);

export default RootLayout;
