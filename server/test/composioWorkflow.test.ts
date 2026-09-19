import { describe, expect, it } from "vitest";
import type { ActionCandidate } from "@ghost/shared";
import { ComposioWorkflowClient, ComposioWorkflowError } from "../src/workflows/composioClient";

interface Call { url: string; init: RequestInit; body?: Record<string, unknown> }

function fakeComposio() {
  const calls: Call[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, init, body });
    if (url.endsWith("/tool_router/session")) return Response.json({ session_id: "trs_demo" }, { status: 201 });
    if (url.includes("/connected_accounts?")) return Response.json({ items: [{ id: "ca_1", user_id: "u1", status: "ACTIVE", alias: "work", toolkit: { slug: "gmail" } }] });
    if (url.endsWith("/link")) return Response.json({ redirect_url: "https://app.composio.dev/link/lt_1", connected_account_id: "ca_2" }, { status: 201 });
    if (url.endsWith("/complete_auth")) return Response.json({ connected_account_id: "ca_2", toolkit_slug: "gmail" });
    if (url.endsWith("/search")) {
      return Response.json({
        success: true,
        results: [{ primary_tool_slugs: ["GMAIL_CREATE_DRAFT_REPLY"] }],
        tool_schemas: { GMAIL_CREATE_DRAFT_REPLY: { toolkit: "gmail", tool_slug: "GMAIL_CREATE_DRAFT_REPLY", input_schema: { type: "object" } } },
      });
    }
    if (url.endsWith("/execute")) return Response.json({ data: { draft_id: "d1" }, log_id: "log_1" });
    return Response.json({}, { status: 404 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("Composio workflow v3.1 client", () => {
  it("creates one scoped session per user, discovers tools, connects accounts, and executes in that session", async () => {
    const fake = fakeComposio();
    const client = new ComposioWorkflowClient({ apiKey: "test-key-not-real", fetch: fake.fetch });
    expect(await client.ensureSession("u1")).toBe("trs_demo");
    expect(await client.ensureSession("u1")).toBe("trs_demo");
    expect(fake.calls.filter((call) => call.url.endsWith("/tool_router/session"))).toHaveLength(1);
    expect(fake.calls[0]?.body).toMatchObject({ user_id: "u1", toolkits: { enabled: expect.arrayContaining(["gmail", "googlecalendar"]) } });

    expect(await client.listConnectedToolkits("u1")).toEqual([{ toolkit: "gmail", accountId: "ca_1", status: "ACTIVE", alias: "work" }]);
    expect(client.peekConnectedToolkits("u1")).toEqual([{ toolkit: "gmail", accountId: "ca_1", status: "ACTIVE", alias: "work" }]);
    expect(await client.createConnectLink("u1", "gmail")).toEqual({ redirectUrl: "https://app.composio.dev/link/lt_1", connectedAccountId: "ca_2" });
    expect(await client.completeAuth("u1", "session-uri-once")).toEqual({ connectedAccountId: "ca_2", toolkit: "gmail" });
    expect(await client.discoverCapability("u1", "gmail.create_draft")).toMatchObject({ actionId: "gmail.create_draft", toolkit: "gmail", toolSlug: "GMAIL_CREATE_DRAFT_REPLY" });
    expect(client.peekCapabilities("u1", ["gmail.create_draft"]).get("gmail.create_draft")).toMatchObject({ toolSlug: "GMAIL_CREATE_DRAFT_REPLY" });

    const candidate = {
      id: "gmail.create_draft",
      title: "Draft",
      description: "Draft",
      executor: "composio",
      toolkit: "gmail",
      toolSlug: "GMAIL_CREATE_DRAFT_REPLY",
      requiredParameters: [],
      safety: "reversible",
      confirmation: "review",
      available: true,
      suggestWhen: "meeting",
      excludeWhen: "never",
      preparedArguments: { thread_id: "t1", message_body: "Thursday works" },
      preview: "Create draft",
    } satisfies ActionCandidate;
    expect(await client.execute("u1", candidate)).toEqual({ draft_id: "d1" });
    const execute = fake.calls.find((call) => call.url.endsWith("/execute"));
    expect(execute?.body).toEqual({ tool_slug: "GMAIL_CREATE_DRAFT_REPLY", arguments: candidate.preparedArguments, enable_auto_workbench_offload: false });
    expect(execute?.init.headers).toMatchObject({ "x-api-key": "test-key-not-real" });
  });

  it("returns a short error code and never includes an upstream body", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: "request echoed secret-value" }), { status: 401 })) as typeof globalThis.fetch;
    const client = new ComposioWorkflowClient({ apiKey: "secret-key", fetch });
    await expect(client.ensureSession("u1")).rejects.toEqual(expect.objectContaining<Partial<ComposioWorkflowError>>({ code: "composio-http-401", status: 401 }));
    try {
      await client.ensureSession("u1");
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
      expect(String(error)).not.toContain("secret-key");
    }
  });
});
