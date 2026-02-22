import { RootProvider } from "fumadocs-ui/provider/next";
import {
  GeistPixelCircle,
  GeistPixelGrid,
  GeistPixelLine,
  GeistPixelSquare,
  GeistPixelTriangle,
} from "geist/font/pixel";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

const fontVariables = [
  GeistSans.variable,
  GeistPixelSquare.variable,
  GeistPixelGrid.variable,
  GeistPixelCircle.variable,
  GeistPixelTriangle.variable,
  GeistPixelLine.variable,
].join(" ");

export const metadata: Metadata = {
  title: "Detent",
  description: "Self-healing CI/CD platform",
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => (
  <html lang="en" suppressHydrationWarning>
    <body className={`${fontVariables} antialiased`}>
      <RootProvider>{children}</RootProvider>
    </body>
  </html>
);

export default RootLayout;
