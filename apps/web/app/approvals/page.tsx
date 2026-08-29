import { buildApprovalCard, formatAmount, type ApprovalCard } from "@nell/views";
import { ago, pendingApprovals } from "@/lib/core";

export const dynamic = "force-dynamic";

/**
 * The card is rendered from `buildApprovalCard`, which returns the hash of the
 * payload it was built from — the same hash the spend gate will require. That is
 * the whole reason this page does not format the payload itself: a screen that
 * composes its own figures can drift from the ones the token commits to, and
 * then the user approves one thing while the agent is authorized for another.
 */
function Card({ card }: { card: ApprovalCard }) {
  return (
    <>
      {card.lines.map((line) => (
        <div className="row" key={line.description} style={{ marginTop: 6 }}>
          <span>
            {line.description}
            {line.quantity > 1 ? ` ×${String(line.quantity)}` : ""}
          </span>
          <span>{formatAmount(line.lineTotal, card.currency)}</span>
        </div>
      ))}

      {card.options.length > 0 ? (
        <div className="muted" style={{ marginTop: 10 }}>
          {card.options.map(([key, value]) => (
            <div key={key}>
              {key}: {value}
            </div>
          ))}
        </div>
      ) : null}

      {/*
        Shown separately rather than folded into the total. A total that quietly
        exceeds the lines above it is precisely the surprise this screen exists
        to prevent.
      */}
      {card.extra !== 0 ? (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted">Fees and extras</span>
          <span className="muted">{formatAmount(card.extra, card.currency)}</span>
        </div>
      ) : null}

      <div
        className="row"
        style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}
      >
        <span>Total</span>
        <span className="total">{formatAmount(card.total, card.currency)}</span>
      </div>

      {/* The bytes the approval is bound to, so a suspicious user can check. */}
      <div className="mono muted" style={{ marginTop: 10 }}>
        binds to {card.payloadHash.slice(0, 16)}…
      </div>
    </>
  );
}

export default function ApprovalsPage() {
  const pending = pendingApprovals();

  return (
    <>
      <h1>Approvals</h1>
      <p className="lede">
        Nell cannot spend without one of these. Approving binds a single-use token to this exact
        amount — if anything changes, it asks again.
      </p>

      {pending.length === 0 ? (
        <p className="empty">Nothing waiting for approval.</p>
      ) : (
        pending.map((item) => {
          const card = buildApprovalCard(item.payload);
          const free = card.total === 0;

          return (
            <div className="panel" key={item.taskId}>
              <div className="row">
                <strong>{card.merchant}</strong>
                <span className="muted">{ago(item.requestedAt)}</span>
              </div>
              <div className="muted">{item.taskLabel}</div>

              <div style={{ marginTop: 12 }}>
                <Card card={card} />
              </div>

              {/*
                A booking that costs nothing today can still cost something later.
                A free reservation carrying a cancellation fee is exactly how a
                shipped agent landed its user with a $200 charge for a table they
                only asked it to find.
              */}
              {free ? (
                <p className="muted" style={{ marginTop: 10 }}>
                  Nothing is charged now. Check the cancellation terms above.
                </p>
              ) : null}

              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button className="action primary" type="button">
                  Approve {formatAmount(card.total, card.currency)}
                </button>
                <button className="action" type="button">
                  No
                </button>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
