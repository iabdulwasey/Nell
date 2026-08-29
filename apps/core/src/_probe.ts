import { installDurableTasks, shutdownDurableTasks } from "./durable-tasks.js";
try {
  const e = await installDurableTasks(process.env["DATABASE_URL"]!, { run: async () => {} });
  console.log("launched ok:", Boolean(e));
  await shutdownDurableTasks();
} catch (err) {
  console.log("FAILED:", err instanceof Error ? err.message : String(err));
}
