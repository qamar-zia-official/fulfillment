"use client";

import { useState } from "react";
import { STATUS_LABELS } from "../lib/queue";
import type { ExceptionDto } from "../lib/api-client";
import styles from "./operations-console.module.css";

/**
 * The inline form for closing one exception.
 *
 * Rendered as a row beneath the exception rather than in a modal. A modal hides the queue behind
 * it, and closing an exception is most of what an operator does here -- so the cost of losing
 * sight of the rest of the list to do it is paid many times a session.
 *
 * A note is required. The API demands one and rejects an empty string, which is the right rule:
 * "resolved" with no reason leaves the next person to reconstruct the decision from a timestamp.
 * The field is marked required rather than relying on the browser's empty-submit validation, so
 * the reason the form will not submit is visible before the click rather than after it.
 */
export const CloseExceptionForm = ({
  exception,
  shopDomain,
  onClose,
  onCancel,
}: {
  readonly exception: ExceptionDto;
  readonly shopDomain: string;
  readonly onClose: (input: { id: string; status: "resolved" | "ignored"; note: string }) => Promise<void>;
  readonly onCancel: () => void;
}) => {
  const [status, setStatus] = useState<"resolved" | "ignored">("resolved");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const trimmed = note.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= 2_000 && !submitting;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setFailure(null);
    try {
      await onClose({ id: exception.id, status, note: trimmed });
    } catch (error) {
      // The console owns the queue refresh, so a failed close is reported here and the row stays
      // open with the note intact. Losing a typed justification because the request timed out is
      // the kind of thing that makes an operator retype it badly the second time.
      setFailure(error instanceof Error ? error.message : "Could not close this exception.");
      setSubmitting(false);
    }
  };

  return (
    <tr className={styles.closeRow}>
      <td colSpan={5}>
        <form className={styles.closeForm} onSubmit={submit}>
          <div className={styles.field}>
            <label htmlFor={`note-${exception.id}`}>Why is this closed? (required)</label>
            <textarea
              id={`note-${exception.id}`}
              className={styles.textarea}
              value={note}
              maxLength={2_000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Stock replenished and re-routed; order is now assigned to KNT-EUR."
            />
            <span className={styles.fieldHint}>
              {trimmed.length}/2000 characters. Recorded against your account and cannot be edited.
            </span>
          </div>

          {failure ? (
            <p className={styles.noticeError} role="alert">
              {failure}
            </p>
          ) : null}

          <div className={styles.closeActions}>
            <button type="submit" className={styles.button} disabled={!canSubmit}>
              {submitting ? "Closing…" : `Mark ${STATUS_LABELS[status].toLowerCase()}`}
            </button>
            <label className={styles.field}>
              <span className={styles.fieldHint}>Outcome</span>
              <select
                className={styles.select}
                value={status}
                onChange={(event) => setStatus(event.target.value as "resolved" | "ignored")}
                disabled={submitting}
              >
                <option value="resolved">Resolved — the underlying problem is fixed</option>
                <option value="ignored">Ignored — understood, no action needed</option>
              </select>
            </label>
            <button type="button" className={`${styles.button} ${styles.buttonQuiet}`} onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
};
