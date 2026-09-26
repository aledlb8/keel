import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Keel — run every coding agent at once",
  description:
    "A native desktop workspace for running and organizing many AI coding agents side by side. Claude Code, Codex, Gemini CLI, opencode and more, each in its own pane.",
  openGraph: {
    title: "Keel",
    description:
      "A native desktop workspace for running many AI coding agents at once.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#050505",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh overflow-x-clip">
        {children}
        <div className="grain" aria-hidden />
      </body>
    </html>
  );
}
