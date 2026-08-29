import { REFERENCE_CATALOG, buildCatalog } from "@nell/agent";
import { estimateMonthlyCost, formatAmount, settingsProblems, tierPanel } from "@nell/views";
import { selectedModels, storedKeys } from "@/lib/core";

export const dynamic = "force-dynamic";

const TIERS = ["nano", "worker", "frontier"] as const;

export default function SettingsPage() {
  const keys = storedKeys();
  const selected = selectedModels();
  const selection = buildCatalog(REFERENCE_CATALOG, selected);
  const problems = settingsProblems(selection, keys);
  const estimate = selection ? estimateMonthlyCost(selection, 100) : undefined;

  return (
    <>
      <h1>Models</h1>
      <p className="lede">
        Nell runs on whichever models you have access to. Mix providers freely — there is no tier
        that only one vendor can serve.
      </p>

      {/* Caught here rather than three steps into a booking, where the failure
          has no visible cause. */}
      {problems.map((problem) => (
        <div
          key={problem.message}
          className={`notice ${problem.severity === "blocking" ? "danger" : "warn"}`}
        >
          {problem.message}
        </div>
      ))}

      {TIERS.map((tier) => {
        const panel = tierPanel(tier, REFERENCE_CATALOG, keys, selected[tier]);

        return (
          <section key={tier}>
            <h2>{panel.title}</h2>
            <p className="muted" style={{ marginTop: -4 }}>
              {panel.explanation}
            </p>

            {panel.options.map((option) => (
              <div className="panel" key={option.id}>
                <div className="row">
                  <span>
                    <input
                      type="radio"
                      name={tier}
                      defaultChecked={option.id === panel.selectedId}
                      disabled={Boolean(option.unavailableBecause)}
                      readOnly
                    />{" "}
                    {option.displayName}
                  </span>
                  <span className="muted">{option.price}</span>
                </div>

                {/* Shown with the reason rather than filtered away: a list that
                    silently omits things is one a user cannot trust they have
                    read. */}
                {option.unavailableBecause ? (
                  <div className="muted" style={{ marginTop: 6 }}>
                    <span className="tag">unavailable</span> {option.unavailableBecause}
                  </div>
                ) : option.needsKey ? (
                  <div className="muted" style={{ marginTop: 6 }}>
                    <span className="tag warn">needs a key</span> Add a {option.provider} key below.
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        );
      })}

      <h2>API keys</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Sent to your server and never returned. This page only ever shows the last four characters —
        enough to tell two keys apart, useless to anyone who sees your screen.
      </p>

      {keys.map((key) => (
        <div className="panel" key={key.provider}>
          <div className="row">
            <strong>{key.provider}</strong>
            <span className="mono muted">{key.hint}</span>
          </div>
        </div>
      ))}

      <div className="panel">
        <div className="row">
          <input
            className="mono"
            type="password"
            placeholder="Paste a key"
            style={{
              flex: 1,
              padding: 8,
              border: "1px solid var(--line)",
              borderRadius: 7,
              background: "transparent",
              color: "inherit",
            }}
            readOnly
          />
          <button className="action" type="button">
            Add
          </button>
        </div>
      </div>

      {estimate ? (
        <>
          <h2>Roughly what this costs</h2>
          <div className="panel">
            <div className="row">
              <span>100 tasks a month</span>
              <span className="total">{formatAmount(estimate.minorUnits, "USD")}</span>
            </div>
            {/* Presenting a rough number as precise is its own kind of lie. */}
            <div className="muted" style={{ marginTop: 6 }}>
              {estimate.caveat}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
