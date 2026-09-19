import { MESSAGES, messagePath, type MailMessage } from "../data/mail";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import "../styles/mail.css";
import { MailChrome } from "./mail/MailChrome";
import { useMailState } from "./mail/useMailState";

function InboxRow({ message, replied }: { message: MailMessage; replied: boolean }) {
  const metaId = `meta-${message.id}`;
  return (
    <li className={message.unread && !replied ? "mail-item mail-item-unread" : "mail-item"}>
      {/* The subject alone names the link (Ghost and tests read it); sender, date and preview describe it. */}
      <Link
        className="mail-row"
        href={messagePath(message.id)}
        aria-label={message.subject}
        aria-describedby={metaId}
        data-testid="mail-row"
        data-mail-id={message.id}
        data-replied={replied ? "true" : undefined}
      >
        <span className="mail-row-from">
          <span className="mail-dot" aria-hidden="true" />
          {/* Its own box: text-overflow does nothing on bare text inside a flex container. */}
          <span className="mail-row-name">{message.from.name}</span>
        </span>
        <span className="mail-row-main">
          <span className="mail-row-subject">{message.subject}</span>
          <span className="mail-row-preview">{message.preview}</span>
        </span>
        <span className="mail-row-side">
          {replied && <span className="mail-badge">Replied</span>}
          <span className="mail-row-date">{message.dateShort}</span>
        </span>
        <span id={metaId} hidden>
          From {message.from.name}, {message.dateShort}
          {message.unread && !replied ? ", unread" : ""}
          {replied ? ", replied" : ""}. {message.preview}
        </span>
      </Link>
    </li>
  );
}

export function Mail(_props: { params: RouteParams }) {
  const mail = useMailState();
  const unread = MESSAGES.filter((m) => m.unread && mail.sentReplies[m.id] === undefined).length;

  return (
    <MailChrome app="Mail">
      <main className="page mail-page">
        <div className="mail-heading">
          <div>
            <p className="eyebrow">Mail</p>
            <h1>Inbox</h1>
          </div>
          <p className="mail-count" data-testid="mail-count">
            {MESSAGES.length} messages, {unread} unread
          </p>
        </div>
        <ul className="mail-list" aria-label="Inbox messages">
          {MESSAGES.map((message) => (
            <InboxRow key={message.id} message={message} replied={mail.sentReplies[message.id] !== undefined} />
          ))}
        </ul>
      </main>
    </MailChrome>
  );
}
