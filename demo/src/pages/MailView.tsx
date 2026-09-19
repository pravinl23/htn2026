import { useEffect } from "react";
import { ME, findMessage, formatPerson, type MailMessage } from "../data/mail";
import { saveLastOpenedId } from "../data/mailStorage";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import "../styles/mail.css";
import { MailChrome } from "./mail/MailChrome";
import { ReplyComposer } from "./mail/ReplyComposer";
import { useMailState } from "./mail/useMailState";

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M9.5 3.5L5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Toolbar() {
  return (
    <nav className="mail-toolbar" aria-label="Message">
      <Link className="mail-tool" href="/mail">
        <BackIcon />
        Back to inbox
      </Link>
      <Link className="mail-tool mail-tool-primary" href="/calendar">
        <CalendarIcon />
        Open calendar
      </Link>
    </nav>
  );
}

function Message({ message }: { message: MailMessage }) {
  return (
    <article className="card mail-message" aria-labelledby="mail-subject">
      <h1 id="mail-subject" data-field="subject">
        {message.subject}
      </h1>
      <dl className="mail-headers">
        <div>
          <dt>From</dt>
          <dd data-field="from">{formatPerson(message.from)}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd data-field="to">{formatPerson(ME)}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd data-field="date">{message.dateLong}</dd>
        </div>
      </dl>
      <div className="mail-body" data-field="body">
        {message.body.map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
    </article>
  );
}

function SentConfirmation({ message, text }: { message: MailMessage; text: string }) {
  return (
    <section className="card mail-sent" data-testid="mail-sent" role="status">
      <h2>Reply sent</h2>
      <p>
        Your reply to {message.from.name} is recorded. This is a local demo, so nothing left your browser. Here is
        what would have gone out:
      </p>
      <pre data-testid="mail-sent-text">{text}</pre>
    </section>
  );
}

function MissingMessage({ id }: { id: string | undefined }) {
  return (
    <section className="card" data-testid="mail-missing">
      <h1>Message not found</h1>
      <p>
        There is no message {id ? <code>{id}</code> : null} in this inbox.
      </p>
    </section>
  );
}

export function MailView({ params }: { params: RouteParams }) {
  const mail = useMailState();
  const message = findMessage(params.id);
  const sentText = message ? mail.sentReplies[message.id] : undefined;
  const messageId = message?.id;

  useEffect(() => {
    if (messageId) saveLastOpenedId(messageId);
  }, [messageId]);

  useEffect(() => {
    window.__mailSent = sentText !== undefined;
  }, [sentText]);

  return (
    <MailChrome app="Mail">
      <main className="page mail-page">
        <Toolbar />
        {message ? (
          <>
            <Message message={message} />
            {sentText === undefined ? (
              <ReplyComposer message={message} pickedSlot={mail.pickedSlot} />
            ) : (
              <SentConfirmation message={message} text={sentText} />
            )}
          </>
        ) : (
          <MissingMessage id={params.id} />
        )}
      </main>
    </MailChrome>
  );
}
