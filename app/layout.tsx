import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Both typefaces are bundled locally: Absans for display/body, Necto Mono for
// the monospace UI (labels, tabular values).
const absans = localFont({
  src: "../public/fonts/Absans-Regular.woff2",
  variable: "--font-absans",
  weight: "400",
  display: "swap",
});

const nectoMono = localFont({
  src: "../public/fonts/NectoMono-Regular.woff2",
  variable: "--font-necto-mono",
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "digital loom",
  description:
    "fabric material authoring: one photograph becomes tunable maps, cloth behavior, and portable assets",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${absans.variable} ${nectoMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
