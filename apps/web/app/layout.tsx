import type { Metadata } from "next";
import { Archivo, Big_Shoulders_Stencil, IBM_Plex_Mono, Manrope } from "next/font/google";
import type { ReactNode } from "react";

import { SessionGate } from "@/components/SessionGate";

import "./globals.css";

// Archivo's width axis gives the wide geometric headings (font-stretch: 125%).
const display = Archivo({ subsets: ["latin"], variable: "--font-archivo", axes: ["wdth"] });
const stencil = Big_Shoulders_Stencil({ subsets: ["latin"], variable: "--font-big-shoulders-stencil", axes: ["opsz"], adjustFontFallback: false });
const sans = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: { default: "Shipyard", template: "%s · Shipyard" },
  description: "Deploy GitHub repositories to your own machine.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${stencil.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh">
        <SessionGate>{children}</SessionGate>
      </body>
    </html>
  );
}
