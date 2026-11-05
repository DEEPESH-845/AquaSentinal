import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Noto_Sans_Devanagari } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });
// Hindi text from Meta models. Neither font above has Devanagari glyphs; preload is off so English pages do not download it up front.
const devanagari = Noto_Sans_Devanagari({ variable: "--font-devanagari", subsets: ["devanagari"], preload: false }); // the variable font covers every weight; a weight list breaks the production build (Turbopack: "queries have exactly one entry")

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
