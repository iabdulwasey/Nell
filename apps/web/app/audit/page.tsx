import { auditView } from "@nell/views";
import { ago, auditEntries } from "@/lib/core";

export const dynamic = "force-dynamic";

const PLAIN: Record<string, string> = {
  "vault.fill": "Typed a stored value into a form",
  "approval.mint": "Asked you to approve a purchase",
  "approval.spend": "Used an approval you granted",
  "purchase.execute": "Completed a purchase",
  "policy.deny": "Refused an action",
  "memory.write": "Remembered something",
  "memory.delete": "Forgot something",
  "secret.decrypt": "Decrypted a stored value",
  "message.outbound": "Sent a message",
};

export default function AuditPage() {
  // Verification runs on every render rather than behind a button. The whole
  // point of hash-chaining a log is that nobody has to be trusted to check it.
  const view = auditView(auditEntries());

  return (
    <>
      <h1>Audit log</h1>
      <p className="lede">
        Every consequential thing Nell has done, in an append-only chain. Each entry commits to the
        one before it, so an entry cannot be altered or removed without breaking the chain.
      </p>

      {view.intact ? (
        <p className="muted">{view.notice}</p>
      ) : (
        // Deliberately alarming. This means someone edited or removed an entry
        // after it was written, and a calm notice would be the wrong register.
        <div className="notice danger">{view.notice}</div>
      )}

      {view.entries.length === 0 ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        [...view.entries]
          .sort((a, b) => b.sequence - a.sequence)
          .map((entry) => (
            <div className="panel" key={entry.sequence}>
              <div className="row">
                <strong>{PLAIN[entry.action] ?? entry.action}</strong>
                <span className="muted">{ago(Date.parse(entry.at))}</span>
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                {entry.subject}
              </div>
              <div className="mono muted" style={{ marginTop: 8 }}>
                #{entry.sequence} · {entry.digest.slice(0, 16)}…
              </div>
            </div>
          ))
      )}
    </>
  );
}
