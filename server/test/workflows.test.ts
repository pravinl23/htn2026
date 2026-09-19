import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { registerWorkflowRoutes } from "../src/routes/workflows";
import { ComposioWorkflowClient } from "../src/workflows/composioClient";

const JSON_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:5173" };
const USER = "demo-user";
const MEETING_CONTEXT = {
  version: 1,
  timestamp: Date.now(),
  activeApplication: { name: "Mail", bundleIdentifier: "com.apple.mail" },
  windowTitle: "Quick chat Thursday afternoon?",
  focusedElement: { role: "AXGroup", label: "Message body" },
  nearbyText: ["Can we meet Thursday afternoon for 30 minutes?"],
  connectedToolkits: ["gmail", "googlecalendar"],
  preferences: { timezone: "America/Toronto", meetingDurationMinutes: 30 },
};

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { response, body: (await response.json()) as Record<string, any> };
}

async function predict(app: ReturnType<typeof createApp>, context: unknown = MEETING_CONTEXT) {
  return post(app, "/v1/workflows/predict", { userId: USER, context, demo: true });
}

async function approveAndExecute(app: ReturnType<typeof createApp>, workflowId: string, actionId: string, confirmation: string) {
  const approved = await post(app, "/v1/workflows/approve", { userId: USER, workflowId, actionId, confirmation });
  expect(approved.response.status).toBe(200);
  return post(app, "/v1/workflows/execute", { userId: USER, workflowId, executionToken: approved.body.executionToken });
}

describe("atomic workflow routes", () => {
  it("runs the polished meeting demo one approved action at a time", async () => {
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));

    const first = await predict(app);
    expect(first.response.status).toBe(200);
    expect(first.body.suggestion).toMatchObject({ action: { id: "calendar.check_availability", confirmation: "tab", safety: "read" }, simulated: true, confidence: 0.92 });
    expect(JSON.stringify(first.body.suggestion)).not.toContain("preparedArguments");
    const workflowId = first.body.workflow.id as string;
    const checked = await approveAndExecute(app, workflowId, "calendar.check_availability", "tab");
    expect(checked.body).toMatchObject({ result: { ok: true, facts: { availableSlot: "Thursday 2:30 PM to 3:00 PM" } }, workflow: { step: "draft-response" } });

    const second = await predict(app);
    expect(second.body.suggestion).toMatchObject({ action: { id: "gmail.create_draft", confirmation: "review" }, preview: expect.stringContaining("Thursday 2:30 PM") });
    const weakApproval = await post(app, "/v1/workflows/approve", { userId: USER, workflowId, actionId: "gmail.create_draft", confirmation: "tab" });
    expect(weakApproval.response.status).toBe(409);
    expect(weakApproval.body.error).toBe("review confirmation is required");
    const drafted = await approveAndExecute(app, workflowId, "gmail.create_draft", "review");
    expect(drafted.body).toMatchObject({ result: { facts: { draftCreated: true } }, workflow: { step: "create-event" } });

    const third = await predict(app);
    expect(third.body.suggestion).toMatchObject({ action: { id: "calendar.create_event", confirmation: "review" } });
    const created = await approveAndExecute(app, workflowId, "calendar.create_event", "review");
    expect(created.body).toMatchObject({ result: { facts: { eventCreated: true } }, workflow: { step: "complete", status: "completed" } });

    const status = await app.request(`/v1/workflows/${USER}`);
    expect(await status.json()).toMatchObject({ workflow: { id: workflowId, status: "completed", history: [{ actionId: "calendar.check_availability" }, { actionId: "gmail.create_draft" }, { actionId: "calendar.create_event" }] } });
  });

  it("turns a visible Slack bug report into one reviewed GitHub issue", async () => {
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));
    const context = {
      version: 1,
      timestamp: Date.now(),
      activeApplication: { name: "Slack", bundleIdentifier: "com.tinyspeck.slackmacgap" },
      windowTitle: "Checkout crashes after applying a coupon",
      focusedElement: { role: "AXGroup", label: "Message in #demo-bugs" },
      nearbyText: ["Regression on the demo branch. Reproducible every time; stack trace points to CouponSummary."],
      connectedToolkits: ["github"],
      preferences: { repository: "ghost-labs/hackathon-demo" },
      relevantActionIds: ["github.create_issue"],
    };

    const predicted = await predict(app, context);
    expect(predicted.response.status).toBe(200);
    expect(predicted.body.suggestion).toMatchObject({
      action: { id: "github.create_issue", confirmation: "review", safety: "reversible" },
      preview: expect.stringContaining("Checkout crashes"),
      simulated: true,
    });
    expect(JSON.stringify(predicted.body.suggestion)).not.toContain("preparedArguments");

    const workflowId = predicted.body.workflow.id as string;
    const executed = await approveAndExecute(app, workflowId, "github.create_issue", "review");
    expect(executed.body).toMatchObject({
      result: { ok: true, facts: { issueNumber: 42, issueCreated: true } },
      workflow: { kind: "issue", step: "complete", status: "completed", history: [{ actionId: "github.create_issue" }] },
    });
  });

  it("requires explicit confirmation for a high-impact action and tokens are single-use", async () => {
    const app = createApp(loadConfig({}));
    const context = { ...MEETING_CONTEXT, windowTitle: "Team update", nearbyText: ["Post the reviewed update"], relevantActionIds: ["slack.send_message"] };
    const predicted = await predict(app, context);
    const workflowId = predicted.body.workflow.id as string;
    expect(predicted.body.suggestion.action).toMatchObject({ id: "slack.send_message", confirmation: "explicit", safety: "high-impact" });
    const tab = await post(app, "/v1/workflows/approve", { userId: USER, workflowId, actionId: "slack.send_message", confirmation: "tab" });
    expect(tab.response.status).toBe(409);
    const approved = await post(app, "/v1/workflows/approve", { userId: USER, workflowId, actionId: "slack.send_message", confirmation: "explicit" });
    const executed = await post(app, "/v1/workflows/execute", { userId: USER, workflowId, executionToken: approved.body.executionToken });
    expect(executed.response.status).toBe(200);
    const repeat = await post(app, "/v1/workflows/execute", { userId: USER, workflowId, executionToken: approved.body.executionToken });
    expect(repeat.response.status).toBe(409);
  });

  it("returns a local directive and waits for verified client feedback", async () => {
    const app = createApp(loadConfig({}));
    const context = {
      version: 1,
      timestamp: Date.now(),
      activeApplication: { name: "Notes", bundleIdentifier: "com.apple.Notes" },
      windowTitle: "Reply notes",
      focusedElement: { role: "AXTextArea", label: "Reply", editableValue: "", safeValueToInsert: "Thursday at 2:30 PM works." },
    };
    const predicted = await predict(app, context);
    expect(predicted.body.suggestion.action).toMatchObject({ id: "local.fill_focused_field", executor: "local", confirmation: "tab" });
    const workflowId = predicted.body.workflow.id as string;
    const executed = await approveAndExecute(app, workflowId, "local.fill_focused_field", "tab");
    expect(executed.body.localAction).toEqual({ id: "local.fill_focused_field", arguments: { text: "Thursday at 2:30 PM works." } });
    expect(executed.body.workflow.history).toHaveLength(0);
    const completed = await post(app, "/v1/workflows/local-result", { userId: USER, workflowId, completionToken: executed.body.completionToken, ok: true });
    expect(completed.body).toMatchObject({ result: { ok: true, facts: { localActionCompleted: true } }, workflow: { history: [{ actionId: "local.fill_focused_field", ok: true }] } });
  });

  it("is inert without a key unless demo mode is explicit", async () => {
    const app = createApp(loadConfig({}));
    const response = await post(app, "/v1/workflows/predict", { userId: USER, context: MEETING_CONTEXT });
    expect(response.body.suggestion).toBeNull();
    expect(response.body.candidates.map((candidate: { id: string }) => candidate.id)).toEqual(["no_action"]);
    const connections = await app.request(`/v1/composio/connections?userId=${USER}`);
    expect(await connections.json()).toEqual({ configured: false, connections: [] });
  });

  it("allows the simulator from localhost but protects every real-account read with the pinned caller token", async () => {
    const calls: string[] = [];
    const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      calls.push(String(input));
      return Response.json({ items: [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } }] });
    }) as typeof globalThis.fetch;
    const token = "test-execute-token-1234";
    const config = loadConfig({ COMPOSIO_API_KEY: "not-real", GHOST_EXECUTE_TOKEN: token });
    const hono = new Hono();
    registerWorkflowRoutes(hono, config, { composio: new ComposioWorkflowClient({ apiKey: "not-real", fetch }) });

    const web = await hono.request(`/v1/composio/connections?userId=${USER}`, { headers: { Origin: "http://localhost:5173" } });
    expect(web.status).toBe(403);
    expect(calls).toHaveLength(0);

    const unpinned = await hono.request(`/v1/composio/connections?userId=${USER}`);
    expect(unpinned.status).toBe(403);
    expect(calls).toHaveLength(0);

    const trusted = await hono.request(`/v1/composio/connections?userId=${USER}`, { headers: { "X-Ghost-Token": token } });
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toMatchObject({ configured: true, connections: [{ toolkit: "gmail", accountId: "ca_1" }] });
    expect(calls).toHaveLength(1);
  });
});
