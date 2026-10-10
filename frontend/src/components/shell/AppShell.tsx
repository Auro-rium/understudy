"use client";

import type { ReactNode } from "react";
import { ConnectionBanner } from "./ConnectionBanner";
import { NavBar } from "./NavBar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-spot focus:px-3 focus:py-2 focus:text-bg"
      >
        Skip to content
      </a>
      <NavBar />
      <ConnectionBanner />
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
