import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authAvailable, SESSION_COOKIE, sessionUser } from "@/lib/auth";

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

/**
 * The guard, and the reason it lives in a layout rather than in each page.
 *
 * Every page under this directory is behind it, so protecting a new one is
 * something you get by putting the file here rather than something you have to
 * remember. A per-page check is a per-page chance to forget, and the page
 * somebody forgets is the one that leaks.
 *
 * `/signin` sits outside this group deliberately — inside it, the redirect
 * would send an unauthenticated visitor to a page that redirects them again.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  /**
   * An install with no Telegram token or encryption key cannot sign anyone in.
   * It stays open rather than becoming unusable — and `docs/self-hosting.md`
   * says plainly that such an install must not leave localhost. Locking a
   * single-user laptop install out of its own dashboard would be worse.
   */
  if (authAvailable()) {
    const jar = await cookies();
    const who = await sessionUser(jar.get(SESSION_COOKIE)?.value);
    if (!who) redirect("/signin");
  }

  return (
    <>
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
    </>
  );
}
