import { useEffect, useRef, useState } from "react";
import type { PickedSlot } from "../../data/calendar";
import type { MailMessage } from "../../data/mail";
import { pickedSlotText, saveSentReply } from "../../data/mailStorage";

interface ComposerProps {
  message: MailMessage;
  pickedSlot: PickedSlot | null;
}

/**
 * "Send reply" is the locked action of this demo: Ghost may draft the text and point at the button, but only a
 * real click or Enter on it may run handleSend. It is type="button" on purpose, so nothing else can trigger it.
 */
export function ReplyComposer({ message, pickedSlot }: ComposerProps) {
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.__formState = { reply };
  }, [reply]);

  function handleSend() {
    const text = reply.trim();
    if (!text) {
      setError("Write a reply before sending.");
      textarea.current?.focus();
      return;
    }
    // Stored locally only. The message view swaps this composer for the confirmation once the store updates.
    if (!saveSentReply(message.id, text)) {
      setError("This browser blocked local storage, so the demo could not record the reply.");
      return;
    }
    window.__mailSent = true;
  }

  return (
    <section className="card mail-reply">
      <h2>Reply to {message.from.name}</h2>
      {pickedSlot && (
        <p className="mail-chip" data-field="picked-slot">
          {pickedSlotText(pickedSlot)}
        </p>
      )}
      <div className="field">
        <label className="label-text" htmlFor="reply">
          Reply
        </label>
        <textarea
          ref={textarea}
          id="reply"
          name="reply"
          rows={6}
          value={reply}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "reply-error" : undefined}
          onChange={(e) => {
            setReply(e.target.value);
            if (error) setError("");
          }}
        />
        {error && (
          <p className="error" id="reply-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="actions mail-reply-actions">
        <button type="button" className="submit" data-testid="send-reply" onClick={handleSend}>
          Send reply
        </button>
        <p className="hint">Local demo: the reply is saved in this browser and never leaves it.</p>
      </div>
    </section>
  );
}
