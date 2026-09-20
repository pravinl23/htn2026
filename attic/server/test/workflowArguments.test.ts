import { describe, expect, it } from "vitest";
import { materializeComposioArguments } from "../src/workflows/arguments";

describe("Composio schema argument materialization", () => {
  it("maps canonical meeting data onto discovered required fields", () => {
    const result = materializeComposioArguments(
      { start: "2026-09-24T16:00:00.000Z", end: "2026-09-24T21:00:00.000Z", timezone: "America/Toronto", calendarId: "primary" },
      {
        type: "object",
        properties: {
          calendar_id: { type: "string", description: "Calendar identifier" },
          time_min: { type: "string", description: "Start datetime" },
          time_max: { type: "string", description: "End datetime" },
          time_zone: { type: "string", description: "IANA timezone" },
        },
        required: ["calendar_id", "time_min", "time_max"],
      },
    );
    expect(result.missing).toEqual([]);
    expect(result.arguments).toEqual({ calendar_id: "primary", time_min: "2026-09-24T16:00:00.000Z", time_max: "2026-09-24T21:00:00.000Z", time_zone: "America/Toronto" });
  });

  it("reports missing required values so the action is filtered before Jev", () => {
    const result = materializeComposioArguments(
      { messageBody: "Thursday works" },
      { properties: { thread_id: { type: "string" }, message_body: { type: "string", description: "Reply message body" } }, required: ["thread_id", "message_body"] },
    );
    expect(result.arguments).toEqual({ message_body: "Thursday works" });
    expect(result.missing).toEqual(["thread_id"]);
  });
});
