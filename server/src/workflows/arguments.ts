interface JsonSchema {
  properties?: Record<string, { type?: unknown; description?: unknown; default?: unknown }>;
  required?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function propertiesOf(schema: Record<string, unknown> | undefined): JsonSchema {
  if (!schema) return {};
  const nested = record(schema.parameters) ? schema.parameters : schema;
  return nested as JsonSchema;
}

function valueFor(key: string, description: string, canonical: Record<string, unknown>): unknown {
  if (canonical[key] !== undefined) return canonical[key];
  const normalizedKey = key.toLowerCase().replace(/[_-]+/g, " ");
  const probe = `${key} ${description}`.toLowerCase().replace(/[_-]+/g, " ");
  const first = (...keys: string[]): unknown => keys.map((name) => canonical[name]).find((value) => value !== undefined);
  // Prefer well-known field names over prose descriptions. Provider descriptions often mention
  // unrelated concepts (for example, `is_html` mentions the email body and attachment docs mention
  // total message size), which must not cause those fields to inherit the message body.
  if (/^(?:body|message body|content)$/.test(normalizedKey)) return first("messageBody", "draftPreview", "requestText");
  if (normalizedKey === "is html") return first("isHtml", "is_html");
  if (/^(?:attachment|attachments)$/.test(normalizedKey)) return first("attachment", "attachments");
  if (/^(?:cc|bcc|extra recipients)$/.test(normalizedKey)) return canonical[key];
  if (/^calendar ?id$/.test(normalizedKey) || /^(?:the )?calendar identifier\b/i.test(description)) return first("calendarId", "calendar_id") ?? "primary";
  if ((normalizedKey === "items" && /calendars?|groups?/i.test(description)) || /^list of calendars/i.test(description)) {
    return [first("calendarId", "calendar_id") ?? "primary"];
  }
  if (/\b(start|time min|from datetime|start datetime)\b/.test(probe)) return first("start", "timeMin");
  if (/\b(end|time max|to datetime|end datetime)\b/.test(probe)) return first("end", "timeMax");
  if (/duration/.test(probe)) return first("durationMinutes");
  if (/time ?zone/.test(probe)) return first("timezone");
  if (/thread.*id/.test(probe)) return first("threadId", "thread_id");
  if (/draft.*id/.test(probe)) return first("draftId", "draft_id");
  if (/recipient|to email|attendee.*email|email.*address/.test(probe)) return first("recipientEmail", "senderEmail", "attendees");
  if (/attendees?/.test(probe)) return first("attendees", "recipientEmail");
  if (/subject|summary|event title|\btitle\b/.test(probe)) return first("subject", "eventTitle", "windowTitle");
  if (/message|body|reply text|content|description/.test(probe)) return first("messageBody", "draftPreview", "requestText");
  if (/query|search|request/.test(probe)) return first("requestText");
  if (/repo/.test(probe)) return first("repository");
  return undefined;
}

function coerce(value: unknown, type: unknown): unknown {
  if (type === "array" && typeof value === "string") return [value];
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  if ((type === "integer" || type === "number") && typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/** Maps canonical, code-produced values onto a discovered tool schema. Missing required values make the action unavailable. */
export function materializeComposioArguments(
  canonical: Record<string, unknown>,
  inputSchema: Record<string, unknown> | undefined,
): { arguments: Record<string, unknown>; missing: string[] } {
  if (!inputSchema) return { arguments: canonical, missing: [] };
  const schema = propertiesOf(inputSchema);
  const properties = record(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const args: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(properties)) {
    const property = record(definition) ? definition : {};
    const description = typeof property.description === "string" ? property.description : "";
    const value = valueFor(key, description, canonical) ?? property.default;
    if (value !== undefined) args[key] = coerce(value, property.type);
  }
  // Some tool-search responses return an empty/opaque schema. Keep the canonical payload rather than pretending it was validated.
  if (Object.keys(properties).length === 0) return { arguments: canonical, missing: [] };
  return { arguments: args, missing: required.filter((key) => args[key] === undefined || args[key] === "") };
}
