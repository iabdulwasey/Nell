import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Nell",
  description: "Your agent, and everything it has done.",
};

/**
 * Nothing but the document.
 *
 * The nav and the sign-in guard moved into `(dashboard)`, so that `/signin` can
 * render without them — a sign-in page wrapped in a layout that redirects
 * unauthenticated visitors to the sign-in page is a loop.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
