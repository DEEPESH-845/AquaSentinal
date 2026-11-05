import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Noto_Sans_Devanagari } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });
// Hindi text from Meta models. Neither font above has Devanagari glyphs; the browser fetches this one only when a page shows some.
const devanagari = Noto_Sans_Devanagari({ variable: "--font-devanagari", subsets: ["devanagari"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "AquaSentinal - AI Underwater Inspection",
  description:
    "Multimodal AI underwater inspection: Muse Spark plans missions from plain language, SAM 3.1 segments what the gantry camera sees, and an adaptive controller scans a digital twin of a camera gantry over a pipeline.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} ${devanagari.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
