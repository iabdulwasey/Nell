import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requestCode, SESSION_COOKIE, SESSION_TTL_MS, verifyCode } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Sign in with a code sent to the owner's Telegram.
 *
 * Two server actions rather than an API route and a client component: the code
 * never needs to reach the browser's JavaScript, and a form that posts to the
 * server works with the tab's scripting disabled. Less to go wrong on the one
 * page whose job is to keep people out.
 */
async function send() {
  "use server";
  const outcome = await requestCode();
  redirect(
    outcome.ok
      ? `/signin?challenge=${encodeURIComponent(outcome.challengeId)}`
      : `/signin?error=${encodeURIComponent(outcome.reason)}`
  );
}

async function check(form: FormData) {
  "use server";
  const challengeId = String(form.get("challenge") ?? "");
  const code = String(form.get("code") ?? "");
  const outcome = await verifyCode(challengeId, code);

  if (!outcome.ok) {
    redirect(
      `/signin?challenge=${encodeURIComponent(challengeId)}&error=${encodeURIComponent(outcome.reason)}`
    );
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, outcome.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    /**
     * Not `secure`, deliberately and narrowly: this is served over plain HTTP
     * on localhost, where `secure` would mean the cookie is silently never
     * stored and sign-in would appear to succeed and never take. Behind TLS,
     * set it — noted in docs/self-hosting.md rather than left as a surprise.
     */
    secure: false,
  });
  redirect("/");
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const challenge = typeof params["challenge"] === "string" ? params["challenge"] : undefined;
  const error = typeof params["error"] === "string" ? params["error"] : undefined;

  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">
        Nell will message you a code on Telegram. Holding that account is what proves this dashboard
        is yours — there is nobody else it could belong to.
      </p>

      {error ? <p className="error">{error}</p> : null}

      {challenge ? (
        <form action={check} className="panel">
          <input type="hidden" name="challenge" value={challenge} />
          <label>
            The six digits Nell just sent you
            <input name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus />
          </label>
          <button type="submit">Sign in</button>
        </form>
      ) : (
        <form action={send} className="panel">
          <button type="submit">Send me a code</button>
        </form>
      )}
    </>
  );
}
