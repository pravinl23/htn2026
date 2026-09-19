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

  it("maps the Google Calendar free/busy items collection to the primary calendar", () => {
    const result = materializeComposioArguments(
      { start: "2026-09-24T18:30:00.000Z", end: "2026-09-24T19:00:00.000Z", timezone: "America/Toronto" },
      {
        type: "object",
        properties: {
          items: { type: "array", description: "List of calendars and/or groups to query." },
          timeMin: { type: "string", description: "The start of the interval." },
          timeMax: { type: "string", description: "The end of the interval." },
          timeZone: { type: "string", description: "Time zone used in the response." },
          groupExpansionMax: { type: "integer", description: "Maximal number of calendar identifiers to provide for a group." },
          calendarExpansionMax: { type: "integer", description: "Maximal number of calendars to return." },
        },
        required: ["timeMin", "timeMax", "items"],
      },
    );
    expect(result.missing).toEqual([]);
    expect(result.arguments).toEqual({
      items: ["primary"],
      timeMin: "2026-09-24T18:30:00.000Z",
      timeMax: "2026-09-24T19:00:00.000Z",
      timeZone: "America/Toronto",
    });
  });

  it("reports missing required values so the action is filtered before Jev", () => {
    const result = materializeComposioArguments(
      { messageBody: "Thursday works" },
      { properties: { thread_id: { type: "string" }, message_body: { type: "string", description: "Reply message body" } }, required: ["thread_id", "message_body"] },
    );
    expect(result.arguments).toEqual({ message_body: "Thursday works" });
    expect(result.missing).toEqual(["thread_id"]);
  });

  it("does not fill Gmail control or attachment fields from descriptive prose", () => {
    const result = materializeComposioArguments(
      { messageBody: "Thursday works", subject: "Meeting availability" },
      {
        properties: {
          body: { type: "string", description: "Email body; recipients can be added later." },
          is_html: { type: "boolean", default: false, description: "True when the body is already HTML." },
          attachment: { type: "object", description: "An attachment; total message size must be under 25 MB." },
          subject: { type: "string", description: "Email subject line." },
          user_id: { type: "string", default: "me", description: "Authenticated user." },
        },
      },
    );
    expect(result.arguments).toEqual({ body: "Thursday works", is_html: false, subject: "Meeting availability", user_id: "me" });
  });
});
