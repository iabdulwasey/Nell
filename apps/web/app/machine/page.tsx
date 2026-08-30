import { machinePanel } from "@nell/views";
import { ago, machine, now } from "@/lib/core";

export const dynamic = "force-dynamic";

export default async function MachinePage() {
  const state = await machine();
  const panel = machinePanel(state, now());

  return (
    <>
      <h1>Your computer</h1>
      <p className="lede">
        A machine that belongs to you and nobody else. It stays signed in to the sites you use, so
        most tasks never need to touch a password at all.
      </p>

      <div className="panel">
        <div className="row">
          <strong>{panel.status}</strong>
          <span className="muted">last used {ago(state.lastUsedAt)}</span>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          {panel.ageDays} days old · {panel.tasksServed} tasks
        </div>
      </div>

      {/*
        The age is not a statistic. It is the reason sites have stopped
        challenging this browser, and it is what the destroy button actually
        costs — so it is stated next to the button rather than hidden behind a
        confirmation dialog nobody reads.
      */}
      <h2>Start over</h2>
      <div className="panel">
        <p style={{ marginTop: 0 }}>{panel.destroyWarning}</p>
        <button className="action danger" type="button">
          Destroy this computer
        </button>
      </div>
    </>
  );
}
