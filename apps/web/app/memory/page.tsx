import { memoryRow } from "@nell/views";
import { ago, memories } from "@/lib/core";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const rows = (await memories()).map(memoryRow).sort((a, b) => b.importance - a.importance);

  return (
    <>
      <h1>Memory</h1>
      <p className="lede">
        Everything Nell remembers about you, why it remembers it, and a way to delete any of it.
        Deleting is real: the data goes, and you get a receipt saying so.
      </p>

      {rows.map((row) => (
        <div className="panel" key={row.id}>
          <div className="row">
            <span>{row.text}</span>
            {/* Every row, without exception. "Revoke did not delete" is the
                specific failure that cost the incumbent its users' trust. */}
            <button className="action danger" type="button">
              Forget
            </button>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            {row.because} · learned {ago(row.learnedAt)}
          </div>
        </div>
      ))}
    </>
  );
}
