import {
  buildCatalog,
  CAPABILITY_LABELS,
  modelCapabilitySchema,
  REFERENCE_CATALOG,
  VENDOR_CAPABILITIES,
  VENDOR_NAMES,
  type ModelCapability,
} from "@nell/agent";
import { estimateMonthlyCost, formatAmount, settingsProblems, tierPanel } from "@nell/views";
import { capabilities, modelAssignment, selectedModels, storedKeys } from "@/lib/core";

export const dynamic = "force-dynamic";

const TIERS = ["nano", "worker", "frontier"] as const;

const MODEL_CAPABILITIES = modelCapabilitySchema.options;

/**
 * Who could take this job, computed rather than written out.
 *
 * A hand-written sentence per capability would be a second copy of
 * `VENDOR_CAPABILITIES` in prose, and prose does not get updated when a vendor
 * ships. Deriving it means the day the table learns that a vendor draws, this
 * line says so.
 */
const VENDORS_FOR: Readonly<Record<ModelCapability, string>> = Object.fromEntries(
  MODEL_CAPABILITIES.map((capability) => {
    const able = Object.entries(VENDOR_CAPABILITIES)
      .filter(([vendor, list]) => list.includes(capability) && vendor !== "self-hosted")
      .map(([vendor]) => VENDOR_NAMES[vendor] ?? vendor);

    return [
      capability,
      able.length > 0 ? `Available from ${able.join(", ")}.` : "No vendor here offers this yet.",
    ];
  })
) as Record<ModelCapability, string>;

export default async function SettingsPage() {
  const keys = storedKeys();
  const selected = selectedModels();
  const selection = buildCatalog(REFERENCE_CATALOG, selected);
  const problems = settingsProblems(selection, keys);
  const estimate = selection ? estimateMonthlyCost(selection, 100) : undefined;

  const report = capabilities();
  const assignment = modelAssignment();
  const waitingBy = new Map<string, ModelCapability[]>();
  for (const entry of report.needsKey) {
    waitingBy.set(entry.vendor, [...(waitingBy.get(entry.vendor) ?? []), entry.capability]);
  }
  const delegatedTo = new Map(report.delegated.map((entry) => [entry.capability, entry.modelId]));

  return (
    <>
      <h1>Models</h1>
      <p className="lede">
        Nell runs on whichever models you have access to. Mix providers freely — there is no tier
        that only one vendor can serve.
      </p>

      {/*
        What this install can do, and what it cannot.

        The section that answers the question somebody actually has when they
        pick a model — *what will my assistant be able to do?* — which the
        catalog could never answer, because it recorded price and tier and
        nothing about capability. A limitation discovered when a task fails is
        a bug report; the same limitation shown here is a decision.
      */}
      <h2>What Nell can do</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Everything runs on <span className="mono">{assignment.defaultModel}</span> unless a job is
        assigned elsewhere below. Nothing here is stored — it is worked out from the model you chose
        and the keys you have added.
      </p>

      <div className="panel">
        {MODEL_CAPABILITIES.map((capability) => {
          const via = delegatedTo.get(capability);
          const waiting = report.needsKey.find((entry) => entry.capability === capability);
          const able = report.can.includes(capability);

          return (
            <div className="row" key={capability} style={{ padding: "6px 0" }}>
              <span>
                <span className={`tag ${able ? "" : waiting ? "warn" : "danger"}`}>
                  {able ? "yes" : waiting ? "key" : "no"}
                </span>{" "}
                {CAPABILITY_LABELS[capability]}
              </span>
              <span className="muted mono">
                {/* Which model, on the line it belongs to. Naming the delegate in a
                    second list reads as two facts where there is one. */}
                {able ? (via ?? "") : waiting ? `needs ${waiting.vendor}` : "nothing assigned"}
              </span>
            </div>
          );
        })}
      </div>

      {/*
        Two gaps that look alike and are fixed differently — one by pasting a
        key, one by choosing a model. Telling somebody to pick an image model
        when they have already picked one reads as the software being broken,
        so they never share a message.
      */}
      {[...waitingBy].map(([vendor, waiting]) => (
        <div className="notice warn" key={vendor}>
          <strong>Add your {VENDOR_NAMES[vendor] ?? vendor} key</strong> to turn on{" "}
          {waiting.map((capability) => CAPABILITY_LABELS[capability].toLowerCase()).join(", ")}. You
          have already chosen the model; it just has nothing to bill.
        </div>
      ))}

      {report.cannot.length > 0 ? (
        <div className="notice warn">
          <strong>
            {assignment.defaultModel} cannot{" "}
            {report.cannot
              .map((capability) => CAPABILITY_LABELS[capability].toLowerCase())
              .join(", ")}
            .
          </strong>{" "}
          {report.wouldFix[0] ? (
            <>
              Pick a model for those jobs below and add a key —{" "}
              {VENDOR_NAMES[report.wouldFix[0]] ?? report.wouldFix[0]} covers most of the gap. Until
              then Nell will say it cannot, rather than doing something else instead.
            </>
          ) : (
            <>Until a model is assigned, Nell will say it cannot rather than substituting.</>
          )}
        </div>
      ) : null}

      {/* A setting that was typed and could not be used is a different problem
          from a capability nobody has: one is fixed by correcting a name. */}
      {report.ignored.map((problem) => (
        <div className="notice danger" key={`${problem.capability}-${problem.modelId}`}>
          <strong>{CAPABILITY_LABELS[problem.capability]}</strong> is set to{" "}
          <span className="mono">{problem.modelId}</span>, which{" "}
          {problem.reason === "unknown-model" ? "is not a model I know" : "cannot do that job"}.
          That setting is being ignored.
        </div>
      ))}

      <h2>Give a job to a different model</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Optional, and most people should leave it alone. One model for everything is the ordinary
        case — this is for when no single vendor does all of it, which is usually drawing.
      </p>

      {MODEL_CAPABILITIES.map((capability) => (
        <div className="panel" key={`assign-${capability}`}>
          <div className="row">
            <span>{CAPABILITY_LABELS[capability]}</span>
            <span className="mono muted">
              {assignment.overrides?.[capability] ?? `${assignment.defaultModel} (default)`}
            </span>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Set <span className="mono">NELL_MODEL_{capability.toUpperCase()}</span> to a model or a
            vendor name. {VENDORS_FOR[capability]}
          </div>
        </div>
      ))}

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
