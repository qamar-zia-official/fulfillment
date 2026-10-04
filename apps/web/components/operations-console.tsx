"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FULFILLMENT_EXCEPTION_SEVERITIES,
  FULFILLMENT_EXCEPTION_STATUSES,
  FULFILLMENT_EXCEPTION_TYPES,
  type ExceptionSeverity,
  type ExceptionStatus,
  type FulfillmentExceptionType,
} from "@repo/domain";
import { closeException, listExceptions, OperationsApiError, type ExceptionDto } from "../lib/api-client";
import { buildExceptionQuery, normaliseShopDomain, SEVERITY_LABELS, STATUS_LABELS, type ExceptionFilters } from "../lib/queue";
import { authClient } from "../lib/auth-client";
import { ExceptionQueue } from "./exception-queue";
import styles from "./operations-console.module.css";

const SHOP_STORAGE_KEY = "kinetous.operations.shopDomain";

const DEFAULT_FILTERS: Omit<ExceptionFilters, "shopDomain"> = {
  statuses: ["open"],
  severities: [],
  types: [],
  limit: 25,
};

/**
 * Reads the last shop this browser used.
 *
 * Local storage rather than a URL query parameter because the shop is a *context* for the whole
 * console, not a link to share. If it were in the URL, pasting a colleague a link to "the
 * blocking exceptions" would carry your last shop along and quietly show them a different
 * merchant's queue -- and with no membership table, "different merchant" currently means
 * "any merchant".
 *
 * The value is re-validated on load, because local storage is editable by hand and by any script
 * that has run on this origin. Treat it as a suggestion, not as a stored fact.
 */
const readStoredShop = (): string | null => {
  try {
    const stored = window.localStorage.getItem(SHOP_STORAGE_KEY);
    if (!stored) return null;
    const result = normaliseShopDomain(stored);
    return result.ok ? result.value : null;
  } catch {
    // Private browsing modes and blocked storage throw on access rather than returning null.
    return null;
  }
};

type SessionState = "checking" | "signed-out" | "ready";

export const OperationsConsole = () => {
  const [session, setSession] = useState<SessionState>("checking");
  const [email, setEmail] = useState<string | null>(null);

  const [shopDomain, setShopDomain] = useState<string | null>(null);
  const [shopInput, setShopInput] = useState("");
  const [shopError, setShopError] = useState<string | null>(null);

  const [filters, setFilters] = useState<Omit<ExceptionFilters, "shopDomain">>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<readonly ExceptionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [queueError, setQueueError] = useState<OperationsApiError | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  /**
   * The session, checked once on mount.
   *
   * The API re-checks it on every call, so this is for the *interface* only -- deciding between
   * "sign in" and "here is the queue" -- and is not a security control. A user whose session
   * expires mid-session keeps a rendered console and gets a 401 on the next action, which the
   * error handling below reports rather than swallowing.
   */
  useEffect(() => {
    const stored = readStoredShop();
    if (stored) {
      setShopDomain(stored);
      setShopInput(stored);
    }

    let cancelled = false;
    authClient
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.user?.email) {
          setEmail(data.user.email);
          setSession("ready");
        } else {
          setSession("signed-out");
        }
      })
      .catch(() => {
        if (!cancelled) setSession("signed-out");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Loads the first page whenever the context changes: the shop, or any filter.
   *
   * Keyed on the pieces rather than the `filters` object, so the request fires when the operator
   * changes something and not on every render. The abort is what stops a slow request for the
   * *previous* shop from resolving after the operator has typed a new one and overwriting the
   * newer result -- the version of this bug where the screen shows one merchant's exceptions
   * under another merchant's name.
   */
  const [loadToken, setLoadToken] = useState(0);

  useEffect(() => {
    if (session !== "ready" || !shopDomain) return;

    const controller = new AbortController();
    const query = buildExceptionQuery({ ...filters, shopDomain });

    setLoading(true);
    setQueueError(null);

    listExceptions(query, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setRows(page.data);
        setNextCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRows([]);
        setNextCursor(null);
        setQueueError(error instanceof OperationsApiError ? error : new OperationsApiError(0, "Could not reach the operations API.", "NETWORK", null));
        setLoading(false);
      });

    return () => controller.abort();
  }, [session, shopDomain, filters, loadToken]);

  const applyShop = (event: React.FormEvent) => {
    event.preventDefault();
    const result = normaliseShopDomain(shopInput);

    if (!result.ok) {
      setShopError(result.reason);
      return;
    }

    setShopError(null);
    setShopDomain(result.value);
    setShopInput(result.value);
    setFlash(null);
    try {
      window.localStorage.setItem(SHOP_STORAGE_KEY, result.value);
    } catch {
      // Not being able to remember the shop is an inconvenience, not a failure to report.
    }
  };

  const loadMore = async () => {
    if (!shopDomain || !nextCursor || loading) return;

    setLoading(true);
    try {
      const page = await listExceptions(buildExceptionQuery({ ...filters, shopDomain, cursor: nextCursor }));
      // Appended rather than replaced: the cursor means "everything after this point", so
      // replacing would show only the second page and look like the first had been filtered away.
      setRows((existing) => [...existing, ...page.data]);
      setNextCursor(page.nextCursor);
      setQueueError(null);
    } catch (error) {
      setQueueError(error instanceof OperationsApiError ? error : new OperationsApiError(0, "Could not load more exceptions.", "NETWORK", null));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Closes an exception, then reloads from the first page.
   *
   * Reloading rather than splicing the row out: a closed entry usually leaves the current view
   * entirely, and the *next* exception behind it is exactly what the operator wants next. A
   * splice would leave a hole and require a manual refresh to fill it.
   */
  const close = useCallback(
    async (input: { id: string; status: "resolved" | "ignored"; note: string }) => {
      if (!shopDomain) return;

      const closed = await closeException({ ...input, shopDomain });
      setFlash(`Closed ${closed.type} as ${STATUS_LABELS[closed.status].toLowerCase()}.`);
      setLoadToken((token) => token + 1);
    },
    [shopDomain],
  );

  const signOut = async () => {
    await authClient.signOut();
    setSession("signed-out");
  };

  if (session === "checking") {
    return (
      <div className={styles.shell}>
        <p className={styles.noticeNeutral} aria-live="polite">
          Checking your session…
        </p>
      </div>
    );
  }

  if (session === "signed-out") {
    return (
      <div className={styles.shell}>
        <div className={styles.signedOut}>
          <h1 className={styles.intro}>Sign in</h1>
          <p className={`${styles.noticeNeutral} ${styles.intro}`}>
            The operations console is limited to accounts on the operator list. Signing in with any other account will be refused by the API.
          </p>
          <a className={styles.button} href="/login">
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.masthead}>
        <div className={styles.wordmark}>
          Kinetous <span>Operations</span>
        </div>
        <div className={styles.identity}>
          <span>{email}</span>
          <button type="button" className={`${styles.button} ${styles.buttonQuiet} ${styles.buttonSmall}`} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className={styles.intro}>
        <h1>Exception queue</h1>
        <p>
          Orders that routing could not complete, and everything raised against them. Closing an entry records your name and reason
          against it permanently.
        </p>
      </div>

      <section className={styles.panel} aria-labelledby="shop-heading">
        <h2 className={styles.panelLegend} id="shop-heading">
          Shop
        </h2>
        <form className={styles.shopRow} onSubmit={applyShop}>
          <div className={`${styles.field} ${styles.grow}`}>
            <label htmlFor="shopDomain">Shop domain</label>
            <input
              id="shopDomain"
              className={styles.input}
              value={shopInput}
              onChange={(event) => setShopInput(event.target.value)}
              placeholder="kinetous.myshopify.com"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button type="submit" className={styles.button}>
            Load queue
          </button>
        </form>
        {shopError ? (
          <p className={styles.noticeError} role="alert" style={{ marginTop: "0.75rem" }}>
            {shopError}
          </p>
        ) : null}
        <p className={styles.fieldHint} style={{ marginTop: "0.5rem" }}>
          Every query is scoped to one shop, and a shop is not tied to your account yet. Until that is built, the operator list grants
          access to every merchant.
        </p>
      </section>

      <section className={styles.panel} aria-labelledby="filters-heading">
        <h2 className={styles.panelLegend} id="filters-heading">
          Filters
        </h2>
        <div className={styles.filters}>
          <div className={styles.field}>
            <label htmlFor="status">Status</label>
            <select
              id="status"
              className={styles.select}
              value={filters.statuses[0] ?? "open"}
              onChange={(event) => setFilters({ ...filters, statuses: [event.target.value as ExceptionStatus] })}
            >
              {FULFILLMENT_EXCEPTION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="severity">Severity</label>
            <select
              id="severity"
              className={styles.select}
              value={filters.severities[0] ?? ""}
              onChange={(event) => setFilters({ ...filters, severities: event.target.value ? [event.target.value as ExceptionSeverity] : [] })}
            >
              <option value="">Any</option>
              {FULFILLMENT_EXCEPTION_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {SEVERITY_LABELS[severity]}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="type">Type</label>
            <select
              id="type"
              className={styles.select}
              value={filters.types[0] ?? ""}
              onChange={(event) => setFilters({ ...filters, types: event.target.value ? [event.target.value as FulfillmentExceptionType] : [] })}
            >
              <option value="">Any</option>
              {FULFILLMENT_EXCEPTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="limit">Page size</label>
            <select id="limit" className={styles.select} value={filters.limit} onChange={(event) => setFilters({ ...filters, limit: Number(event.target.value) })}>
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {flash ? (
        <p className={styles.noticeGood} role="status" style={{ marginBottom: "1rem" }}>
          {flash}
        </p>
      ) : null}

      {queueError ? (
        <div className={styles.noticeError} role="alert" style={{ marginBottom: "1rem" }}>
          <strong>
            {queueError.status === 401
              ? "Your session has expired."
              : queueError.status === 403
                ? "This account is not on the operator list."
                : queueError.status === 0
                  ? "Could not reach the API."
                  : `The API refused this request (${queueError.status}).`}
          </strong>{" "}
          {queueError.message}
          {queueError.requestId ? <code className={styles.requestId}>request {queueError.requestId}</code> : null}
        </div>
      ) : null}

      {!shopDomain ? (
        <p className={styles.noticeNeutral}>Enter a shop domain above to load its queue.</p>
      ) : loading && rows.length === 0 ? (
        <p className={styles.noticeNeutral} aria-live="polite">
          Loading the queue for {shopDomain}…
        </p>
      ) : (
        <ExceptionQueue rows={rows} shopDomain={shopDomain} hasMore={nextCursor !== null} loading={loading} onLoadMore={loadMore} onClose={close} />
      )}
    </div>
  );
};
