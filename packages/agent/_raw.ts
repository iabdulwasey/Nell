const body = {
  model: "claude-sonnet-4-5",
  max_tokens: 8192,
  system:
    "Do the job properly. Write and run code when a file has to be produced — a real PDF, not a description of one.",
  tools: [
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    { type: "code_execution_20250522", name: "code_execution" },
  ],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Build a pdf perfectly designed and formatted on local indian Lucknow foods",
        },
      ],
    },
  ],
};
const t0 = Date.now();
const r = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": process.env["ANTHROPIC_API_KEY"]!,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "code-execution-2025-05-22,files-api-2025-04-14",
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});
const d = (await r.json()) as any;
console.log(
  "http",
  r.status,
  `${String(Math.round((Date.now() - t0) / 1000))}s`,
  "stop:",
  d.stop_reason
);
for (const b of d.content ?? []) {
  if (b.type === "code_execution_tool_result") {
    const c = b.content ?? {};
    console.log("  RESULT keys:", Object.keys(c));
    console.log("    return_code:", c.return_code, "stderr:", String(c.stderr ?? "").slice(0, 200));
    console.log("    content:", JSON.stringify(c.content ?? []).slice(0, 300));
  } else if (b.type === "server_tool_use") {
    console.log("  TOOL:", b.name);
  } else if (b.type === "text") {
    console.log("  TEXT:", b.text.slice(0, 120).replace(/\n/g, " "));
  } else console.log("  block:", b.type);
}
