import { vaultRow } from "@nell/views";
import { ago, vaultItems } from "@/lib/core";

export const dynamic = "force-dynamic";

/**
 * There is no code path on this page that could render a secret, because the
 * type it receives has nowhere to put one. That is deliberate: masking a value
 * in CSS or truncating it in a template still means the value reached the
 * browser, and once it has left the server every later protection is decoration.
 */
export default function VaultPage() {
  const rows = vaultItems().map(vaultRow);

  return (
    <>
      <h1>Vault</h1>
      <p className="lede">
        Stored on the server, encrypted, and typed straight into a form when it is needed. Nell
        never sends a value to this page, and never shows one to the model.
      </p>

      {rows.map((row) => (
        <div className="panel" key={row.id}>
          <div className="row">
            <strong>{row.label}</strong>
            <span className="tag">{row.kind}</span>
          </div>

          <div className="muted" style={{ marginTop: 6 }}>
            {row.placeholder}
          </div>

          <div className="muted" style={{ marginTop: 8 }}>
            {row.origins.length > 0 ? (
              <>Only fillable on {row.origins.join(", ")}</>
            ) : (
              // A login that silently does nothing reads as a broken agent
              // rather than as a setting nobody finished.
              <span className="tag warn">No site approved — this can never be used</span>
            )}
          </div>

          <div className="muted" style={{ marginTop: 8 }}>
            updated {ago(row.updatedAt)}
            {row.lastUsedAt ? ` · last used ${ago(row.lastUsedAt)}` : " · never used"}
          </div>
        </div>
      ))}
    </>
  );
}
