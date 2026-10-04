"use client";

import { Fragment, useState } from "react";
import type { ExceptionSeverity, ExceptionStatus } from "@repo/domain";
import type { ExceptionDto } from "../lib/api-client";
import { formatAge, formatTimestamp, SEVERITY_LABELS, STATUS_LABELS, summariseDetails } from "../lib/queue";
import { CloseExceptionForm } from "./close-exception-form";
import styles from "./operations-console.module.css";

/**
 * Status -> badge class, as a lookup rather than a template string.
 *
 * `styles[`badge${status}`]` is shorter and wrong twice over: it type-checks against an index
 * signature that cannot tell a typo from a real class, and it yields `undefined` for any status
 * the domain adds before this file is updated, silently dropping the badge. A `Record` over the
 * union fails to compile instead.
 */
const STATUS_BADGE_CLASS: Readonly<Record<ExceptionStatus, string | undefined>> = {
  open: styles.badgeOpen,
  resolved: styles.badgeResolved,
  ignored: styles.badgeIgnored,
};

const SEVERITY_BADGE_CLASS: Readonly<Record<ExceptionSeverity, string | undefined>> = {
  blocking: styles.badgeBlocking,
  warning: styles.badgeWarning,
};

/**
 * The queue table.
 *
 * A real `<table>` with real headers, not a grid of divs. This is a data table that a keyboard
 * user has to be able to read in order, and `role="grid"` on divs is a promise to rebuild
 * something the platform already provides correctly.
 *
 * Two rendering decisions worth naming:
 *
 *   - The age is relative, with the absolute UTC time in the tooltip. Relative answers "is this
 *     fresh or has it been sitting here?", which is the question on a triage screen; the absolute
 *     time is what an operator copies into a ticket or compares against an audit log.
 *   - The close affordance only exists on open rows. Offering it on a resolved row would let an
 *     operator start writing a justification for something already handled, and the API would
 *     answer 409 for a reason that is not obvious from the screen.
 */
export const ExceptionQueue = ({
  rows,
  shopDomain,
  hasMore,
  loading,
  onLoadMore,
  onClose,
}: {
  readonly rows: readonly ExceptionDto[];
  readonly shopDomain: string;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
  readonly onClose: (input: { id: string; status: "resolved" | "ignored"; note: string }) => Promise<void>;
}) => {
  const [closing, setClosing] = useState<string | null>(null);
  // Captured once per render pass for every row's age. Reading the clock per cell would let two
  // rows in the same table disagree about what "now" is.
  const now = Date.now();

  if (rows.length === 0) {
    return (
      <p className={styles.noticeNeutral}>
        Nothing matches these filters for <strong>{shopDomain}</strong>. That is either good news or a filter that is too narrow.
      </p>
    );
  }

  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Exception</th>
              <th scope="col">Order</th>
              <th scope="col">Status</th>
              <th scope="col">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((exception) => {
              const isOpen = exception.status === "open";

              return (
                <Fragment key={exception.id}>
                  <tr>
                    <td>
                      <span className={`${styles.badge} ${SEVERITY_BADGE_CLASS[exception.severity]}`}>{SEVERITY_LABELS[exception.severity]}</span>
                    </td>
                    <td>
                      <div className={styles.exceptionType}>{exception.type}</div>
                      <div className={styles.reason}>{exception.reason}</div>
                      {summariseDetails(exception.details) ? <div className={styles.details}>{summariseDetails(exception.details)}</div> : null}
                    </td>
                    <td className={styles.mono}>{exception.orderId}</td>
                    <td>
                      <div className={styles.statusCell}>
                        <span className={`${styles.badge} ${STATUS_BADGE_CLASS[exception.status]}`}>{STATUS_LABELS[exception.status]}</span>
                        {isOpen ? (
                          <button type="button" className={`${styles.button} ${styles.buttonQuiet} ${styles.buttonSmall}`} onClick={() => setClosing(exception.id)}>
                            Close
                          </button>
                        ) : null}
                        {exception.resolvedBy ? (
                          <>
                            <div className={styles.details} title={exception.resolvedAt ? formatTimestamp(exception.resolvedAt) : undefined}>
                              {exception.resolvedBy}
                            </div>
                            <div className={styles.details}>{exception.resolutionNote}</div>
                          </>
                        ) : null}
                      </div>
                    </td>
                    <td className={styles.age} title={formatTimestamp(exception.createdAt)}>
                      {formatAge(exception.createdAt, now)}
                    </td>
                  </tr>
                  {closing === exception.id ? (
                    <CloseExceptionForm
                      exception={exception}
                      shopDomain={shopDomain}
                      onClose={async (input) => {
                        await onClose(input);
                        setClosing(null);
                      }}
                      onCancel={() => setClosing(null)}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.footer}>
        <span className={styles.fieldHint}>
          {rows.length} loaded{hasMore ? ", more available" : ""}
        </span>
        {hasMore ? (
          <button type="button" className={`${styles.button} ${styles.buttonQuiet}`} onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </>
  );
};
