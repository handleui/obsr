import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "ObsR",
    template: "%s | ObsR",
  },
  description:
    "Ingest raw failures, cluster related evidence, and turn them into one issue with a concrete fix plan.",
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
