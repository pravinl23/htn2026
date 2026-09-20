import type { ActionDefinition, WorkflowConfirmation, WorkflowSafetyLevel } from "@ghost/shared";

export interface ActionSpec {
  definition: Omit<ActionDefinition, "available" | "toolSlug">;
  /** Semantic search text for a Composio session. */
  searchQuery?: string;
  /** Accept only discovered slugs matching one of these patterns. */
  toolSlugPatterns?: RegExp[];
}

function confirmation(safety: WorkflowSafetyLevel): WorkflowConfirmation {
  return safety === "read" ? "tab" : safety === "reversible" ? "review" : "explicit";
}

function composio(
  id: string,
  title: string,
  description: string,
  toolkit: string,
  safety: WorkflowSafetyLevel,
  searchQuery: string,
  toolSlugPatterns: RegExp[],
  suggestWhen: string,
  excludeWhen: string,
): ActionSpec {
  return {
    definition: {
      id,
      title,
      description,
      executor: "composio",
      toolkit,
      requiredParameters: [],
      safety,
      confirmation: confirmation(safety),
      suggestWhen,
      excludeWhen,
    },
    searchQuery,
    toolSlugPatterns,
  };
}

export const ACTION_SPECS: Record<string, ActionSpec> = {
  "calendar.check_availability": composio(
    "calendar.check_availability",
    "Check calendar availability",
    "Read the connected calendar for free time matching the meeting request.",
    "googlecalendar",
    "read",
    "Check Google Calendar availability for a requested meeting time range without creating or changing events",
    [/GOOGLECALENDAR_.*(?:FREE|AVAIL|EVENTS|CALENDAR).*LIST/i, /GOOGLECALENDAR_.*(?:FREE|AVAIL)/i],
    "A visible message asks to meet and availability has not been checked.",
    "No meeting request is visible, calendar is disconnected, or availability is already known.",
  ),
  "gmail.create_draft": composio(
    "gmail.create_draft",
    "Create draft response",
    "Create a Gmail draft that proposes the selected available time. It does not send the message.",
    "gmail",
    "reversible",
    "Create a Gmail draft reply to an existing email thread without sending it",
    [/GMAIL_.*(?:CREATE|DRAFT).*DRAFT/i, /GMAIL_CREATE_DRAFT/i],
    "Calendar availability is known for a meeting-request email.",
    "No recipient/thread or available time is known, or Gmail is disconnected.",
  ),
  "calendar.create_event": composio(
    "calendar.create_event",
    "Create tentative event",
    "Create the reviewed calendar event for the agreed time.",
    "googlecalendar",
    "reversible",
    "Create a Google Calendar event with attendees, start time, end time, and description",
    [/GOOGLECALENDAR_.*CREATE.*EVENT/i],
    "An available time is known and the draft response has been created.",
    "The proposed event details are incomplete or have not been reviewed.",
  ),
  "gmail.send_draft": composio(
    "gmail.send_draft",
    "Send email draft",
    "Send an existing Gmail draft.",
    "gmail",
    "high-impact",
    "Send an existing Gmail draft by draft ID",
    [/GMAIL_.*SEND.*DRAFT/i],
    "The user explicitly requests sending a reviewed draft.",
    "The draft has not been reviewed or ordinary Tab approval is the only confirmation.",
  ),
  "slack.send_message": composio(
    "slack.send_message",
    "Send Slack update",
    "Send the reviewed message to a selected Slack channel.",
    "slack",
    "high-impact",
    "Send a Slack channel message",
    [/SLACK_.*SEND.*MESSAGE/i],
    "A completed workflow needs a team update and the channel and message are known.",
    "The channel or exact message is missing, or explicit confirmation has not been given.",
  ),
  "github.create_issue": composio(
    "github.create_issue",
    "Create GitHub issue",
    "Create a reviewed issue in the selected repository.",
    "github",
    "reversible",
    "Create a GitHub issue with title and body in a repository",
    [/GITHUB_.*CREATE.*ISSUE/i],
    "A visible bug report has a repository, title, and body.",
    "The repository is unknown or the visible content is not an actionable issue.",
  ),
  "notion.create_page": composio(
    "notion.create_page",
    "Save to Notion",
    "Create a reviewed Notion page from the relevant visible information.",
    "notion",
    "reversible",
    "Create a Notion page in a selected parent page or database",
    [/NOTION_.*CREATE.*PAGE/i],
    "The user is collecting visible information and a destination is known.",
    "The destination or page contents are missing.",
  ),
  "local.fill_focused_field": {
    definition: {
      id: "local.fill_focused_field",
      title: "Fill focused field",
      description: "Insert the already-prepared value into the current non-sensitive editable field.",
      executor: "local",
      requiredParameters: [{ name: "text", type: "string", required: true, description: "Text prepared locally before prediction." }],
      safety: "reversible",
      confirmation: "tab",
      suggestWhen: "A safe value is prepared locally and the focused field is editable and empty.",
      excludeWhen: "The field is secure, sensitive, non-editable, already filled, or no value is prepared.",
    },
  },
  no_action: {
    definition: {
      id: "no_action",
      title: "No action",
      description: "Do not suggest or execute anything.",
      executor: "none",
      requiredParameters: [],
      safety: "read",
      confirmation: "tab",
      suggestWhen: "No supplied action is appropriate or confidence is too low.",
      excludeWhen: "A clearly appropriate action is available.",
    },
  },
};

export const DEMO_TOOL_SLUGS: Record<string, string> = {
  "calendar.check_availability": "GOOGLECALENDAR_FIND_FREE_SLOTS",
  "gmail.create_draft": "GMAIL_CREATE_DRAFT_REPLY",
  "calendar.create_event": "GOOGLECALENDAR_CREATE_EVENT",
  "gmail.send_draft": "GMAIL_SEND_DRAFT",
  "slack.send_message": "SLACK_SEND_MESSAGE",
  "github.create_issue": "GITHUB_CREATE_AN_ISSUE",
  "notion.create_page": "NOTION_CREATE_PAGE",
};
