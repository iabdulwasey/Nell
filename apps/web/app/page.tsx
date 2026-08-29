import { groupTasks } from "@nell/views";
import { ago, tasks } from "@/lib/core";

export const dynamic = "force-dynamic";

const STATE_TAG: Record<string, string> = {
  running: "ok",
  queued: "",
  blocked: "warn",
  done: "",
  failed: "danger",
  cancelled: "",
};

export default function TasksPage() {
  const groups = groupTasks(tasks());

  return (
    <>
      <h1>Tasks</h1>
      <p className="lede">Everything Nell is doing, and everything it needs from you.</p>

      {/*
        Blocked first, and never mixed in with the failures. A task waiting on a
        CAPTCHA has not gone wrong, and burying it under things that did teaches
        people to stop reading the one list that needs them.
      */}
      <h2>Needs you</h2>
      {groups.needsYou.length === 0 ? (
        <p className="empty">Nothing is waiting on you.</p>
      ) : (
        groups.needsYou.map((task) => (
          <div className="panel" key={task.id}>
            <div className="row">
              <strong>{task.label}</strong>
              <span className="tag warn">blocked</span>
            </div>
            <div className="muted">{task.blockedOn ?? "Waiting for you."}</div>
            {task.liveViewUrl ? (
              <p style={{ margin: "10px 0 0" }}>
                <a href={task.liveViewUrl}>Take over →</a>
              </p>
            ) : null}
          </div>
        ))
      )}

      <h2>Running</h2>
      {groups.active.length === 0 ? (
        <p className="empty">Nothing running.</p>
      ) : (
        groups.active.map((task) => (
          <div className="panel" key={task.id}>
            <div className="row">
              <strong>{task.label}</strong>
              <span className={`tag ${STATE_TAG[task.state] ?? ""}`}>{task.state}</span>
            </div>
            <div className="row">
              <span className="muted">{ago(task.updatedAt)}</span>
              {task.liveViewUrl ? <a href={task.liveViewUrl}>Watch</a> : null}
            </div>
          </div>
        ))
      )}

      <h2>Finished</h2>
      {groups.finished.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        groups.finished.map((task) => (
          <div className="panel" key={task.id}>
            <div className="row">
              <strong>{task.label}</strong>
              <span className={`tag ${STATE_TAG[task.state] ?? ""}`}>{task.state}</span>
            </div>
            <div className="row">
              <span className="muted">{ago(task.updatedAt)}</span>
              {/* The recording is the receipt: what it actually did, not what it says it did. */}
              {task.replayUrl ? <a href={task.replayUrl}>Recording</a> : null}
            </div>
          </div>
        ))
      )}
    </>
  );
}
