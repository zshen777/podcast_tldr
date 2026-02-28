import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podcast TLDR",
  description: "Summarize long YouTube podcasts into quick morning TLDRs",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
