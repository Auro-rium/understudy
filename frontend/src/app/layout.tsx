import type { Metadata } from "next";
import type { ReactNode } from "react";
import { StoreProvider } from "@/lib/store";
import { AppShell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Understudy — local AI that learns from a teacher",
  description:
    "A small local model answers gig-worker support tickets, asks a cloud teacher only when unsure, and learns from every answer.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-bg text-ink">
        <StoreProvider>
          <AppShell>{children}</AppShell>
        </StoreProvider>
      </body>
    </html>
  );
}
