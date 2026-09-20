import type { ActionCandidate, ContextSnapshot, WorkflowState } from "@ghost/shared";
import { ACTION_SPECS, DEMO_TOOL_SLUGS } from "./catalog";
import { materializeComposioArguments } from "./arguments";

export interface ResolvedCapability {
  actionId: string;
  toolSlug: string;
  toolkit: string;
  inputSchema?: Record<string, unknown>;
}

const MEETING = /\b(meet|meeting|calendar|availability|available|schedule|chat|call)\b/i;
const ISSUE = /\b(bug|issue|regression|broken|fails?|error|todo|ticket)\b/i;

function visibleText(context: ContextSnapshot): string {
  return [context.windowTitle, context.focusedElement?.label, context.focusedElement?.selectedText, ...(context.nearbyText ?? [])].filter(Boolean).join("\n");
}

function connected(context: ContextSnapshot, toolkit: string, simulated: boolean): boolean {
  return simulated || (context.connectedToolkits ?? []).includes(toolkit);
}

function capability(actionId: string, capabilities: Map<string, ResolvedCapability>, simulated: boolean): ResolvedCapability | undefined {
  const found = capabilities.get(actionId);
  if (found) return found;
  const spec = ACTION_SPECS[actionId];
  const slug = DEMO_TOOL_SLUGS[actionId];
  return simulated && spec?.definition.toolkit && slug ? { actionId, toolSlug: slug, toolkit: spec.definition.toolkit } : undefined;
}

function candidate(
  actionId: string,
  preparedArguments: Record<string, unknown>,
  preview: string,
  capabilities: Map<string, ResolvedCapability>,
  simulated: boolean,
): ActionCandidate | undefined {
  const spec = ACTION_SPECS[actionId];
  if (!spec) return undefined;
  if (spec.definition.executor === "local" || spec.definition.executor === "none") {
    return { ...spec.definition, available: true, preparedArguments, preview, simulated };
  }
  const resolved = capability(actionId, capabilities, simulated);
  if (!resolved) return undefined;
  const materialized = materializeComposioArguments(preparedArguments, resolved.inputSchema);
  if (materialized.missing.length) return undefined;
  return { ...spec.definition, toolSlug: resolved.toolSlug, available: true, preparedArguments: materialized.arguments, preview, simulated };
}

function nextWeekdayWindow(timestamp: number, weekday: number, startHour: number, endHour: number): { start: string; end: string } {
  const date = new Date(timestamp);
  const delta = (weekday - date.getUTCDay() + 7) % 7 || 7;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + delta, startHour));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + delta, endHour));
  return { start: start.toISOString(), end: end.toISOString() };
}

function inferMeetingWindow(context: ContextSnapshot): { start?: string; end?: string } {
  const content = visibleText(context);
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(content));
  if (weekday < 0) return {};
  const exact = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(content);
  if (exact) {
    let hour = Number(exact[1]) % 12;
    if (exact[3]?.toLowerCase() === "pm") hour += 12;
    const window = nextWeekdayWindow(context.timestamp, weekday, hour, hour + 1);
    const minutes = Number(exact[2] ?? 0);
    const start = new Date(window.start);
    const end = new Date(window.start);
    start.setUTCMinutes(minutes);
    end.setUTCMinutes(minutes + Number(context.preferences?.meetingDurationMinutes ?? 30));
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (/afternoon/i.test(content)) return nextWeekdayWindow(context.timestamp, weekday, 12, 17);
  if (/morning/i.test(content)) return nextWeekdayWindow(context.timestamp, weekday, 8, 12);
  return nextWeekdayWindow(context.timestamp, weekday, 9, 17);
}

function meetingArgs(context: ContextSnapshot, state: WorkflowState): Record<string, unknown> {
  const requestText = visibleText(context).slice(0, 1800);
  const durationMinutes = typeof context.preferences?.meetingDurationMinutes === "number" ? context.preferences.meetingDurationMinutes : 30;
  const availableSlot = String(state.facts.availableSlot ?? "the available time");
  const preferenceArgs = Object.fromEntries(
    ["threadId", "recipientEmail", "senderEmail", "subject", "calendarId", "eventTitle", "attendees"].flatMap((key) =>
      context.preferences?.[key] !== undefined ? [[key, context.preferences[key]]] : [],
    ),
  );
  return {
    requestText,
    durationMinutes,
    timezone: String(context.preferences?.timezone ?? "America/Toronto"),
    windowTitle: context.windowTitle,
    subject: context.preferences?.subject ?? context.windowTitle,
    eventTitle: context.preferences?.eventTitle ?? `Meeting: ${context.windowTitle ?? "requested meeting"}`,
    messageBody: `Thanks for reaching out. ${availableSlot} works for me. Looking forward to it!`,
    ...inferMeetingWindow(context),
    ...preferenceArgs,
    ...state.facts,
  };
}

export function inferWorkflowKind(context: ContextSnapshot): WorkflowState["kind"] {
  const content = visibleText(context);
  if (MEETING.test(content)) return "meeting";
  if (ISSUE.test(content)) return "issue";
  return "generic";
}

export function initialStep(kind: WorkflowState["kind"]): string {
  return kind === "meeting" ? "check-availability" : kind === "issue" ? "create-issue" : "observe";
}

/** Code filters to a tiny list before Jev sees action ids. Parameter values stay out of the Jev question. */
export function getRelevantActions(
  context: ContextSnapshot,
  state: WorkflowState,
  capabilities: Map<string, ResolvedCapability>,
  simulated: boolean,
): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  const hinted = new Set(context.relevantActionIds ?? []);

  if (context.focusedElement?.safeValueToInsert && !context.focusedElement.editableValue) {
    const local = candidate(
      "local.fill_focused_field",
      { text: context.focusedElement.safeValueToInsert, identifier: context.focusedElement.identifier },
      `Fill “${context.focusedElement.label ?? "focused field"}” with the prepared text`,
      capabilities,
      simulated,
    );
    if (local) candidates.push(local);
  }

  if (state.kind === "meeting") {
    const args = meetingArgs(context, state);
    if (state.step === "check-availability" && connected(context, "googlecalendar", simulated)) {
      const action = candidate("calendar.check_availability", args, "Check the connected calendar for a matching free slot", capabilities, simulated);
      if (action) candidates.push(action);
    }
    if (state.step === "draft-response" && connected(context, "gmail", simulated)) {
      const action = candidate(
        "gmail.create_draft",
        args,
        `Create a draft response proposing ${String(state.facts.availableSlot ?? "the available time")}`,
        capabilities,
        simulated,
      );
      if (action) candidates.push(action);
    }
    if (state.step === "create-event" && connected(context, "googlecalendar", simulated)) {
      const action = candidate(
        "calendar.create_event",
        args,
        `Create a 30-minute tentative event at ${String(state.facts.availableSlot ?? "the reviewed time")}`,
        capabilities,
        simulated,
      );
      if (action) candidates.push(action);
    }
  }

  if ((state.kind === "issue" || hinted.has("github.create_issue")) && state.step === "create-issue" && connected(context, "github", simulated)) {
    const content = visibleText(context).slice(0, 1800);
    const action = candidate(
      "github.create_issue",
      { repository: context.preferences?.repository, title: context.windowTitle ?? "Issue from current context", body: content },
      `Create a reviewed GitHub issue from “${context.windowTitle ?? "the current report"}”`,
      capabilities,
      simulated,
    );
    if (action) candidates.push(action);
  }

  for (const id of hinted) {
    if (candidates.some((item) => item.id === id) || !ACTION_SPECS[id]) continue;
    const spec = ACTION_SPECS[id];
    if (spec.definition.executor === "composio" && spec.definition.toolkit && !connected(context, spec.definition.toolkit, simulated)) continue;
    const action = candidate(id, { context: visibleText(context).slice(0, 1200) }, spec.definition.title, capabilities, simulated);
    if (action) candidates.push(action);
  }

  const none = candidate("no_action", {}, "Do nothing", capabilities, simulated);
  if (none) candidates.push(none);
  return candidates.slice(0, 8);
}

export function advanceAfterAction(state: WorkflowState, actionId: string): { step: string; completed?: boolean } {
  if (state.kind === "meeting") {
    if (actionId === "calendar.check_availability") return { step: "draft-response" };
    if (actionId === "gmail.create_draft") return { step: "create-event" };
    if (actionId === "calendar.create_event") return { step: "complete", completed: true };
  }
  if (state.kind === "issue" && actionId === "github.create_issue") return { step: "complete", completed: true };
  return { step: state.step };
}
