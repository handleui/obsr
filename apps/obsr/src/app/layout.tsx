import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Observer MVP",
    template: "%s | Observer MVP",
  },
  description:
    "Paste CI logs, extract diagnostics, and build a compact fix prompt.",
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => {
  return (
    <html lang="en">
      <body
        className={`${GeistSans.variable} bg-canvas font-sans text-ink antialiased`}
      >
        {children}
      </body>
    </html>
  );
};

export default RootLayout;
