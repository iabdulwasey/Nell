import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Nell",
  description: "Your agent, and everything it has done.",
};

/**
 * The nav order is the order things matter when something is wrong: what needs
 * you, then what is running, then the things you check when you want to know
 * whether to trust any of it.
 */
const LINKS = [
  ["/", "Tasks"],
  ["/approvals", "Approvals"],
  ["/machine", "Your computer"],
  ["/vault", "Vault"],
  ["/memory", "Memory"],
  ["/audit", "Audit log"],
  ["/settings", "Models"],
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="side">
            <div className="brand">Nell</div>
            {LINKS.map(([href, label]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
