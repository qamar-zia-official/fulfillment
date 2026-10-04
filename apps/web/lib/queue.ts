import type { ExceptionSeverity, ExceptionStatus, FulfillmentExceptionType } from "@repo/domain";

/**
 * Pure logic for the operations console.
 *
 * Everything here is a function of its arguments with no clock, no fetch and no React. That is
 * what makes it worth splitting out: the parts of a dashboard that are easy to get subtly wrong
 * -- normalising what an operator pastes, building the filter query, describing an age -- are
 * exactly the parts that are painful to test through a rendered component, and the components
 * that consume them end up as thin enough to read at a glance.
 *
 * `@repo/domain` supplies the vocabularies, so the filter dropdowns and the API's validation
 * cannot drift apart.
 */

export type ShopDomainResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/**
 * Normalises a pasted shop domain.
 *
 * Operators paste these from a browser URL bar and from Shopify admin, so `https://` prefixes,
 * trailing slashes, admin paths, mixed case and stray whitespace all arrive in practice. The API
 * stores `shop_domain` as a header value straight from Shopify and compares it exactly, so a
 * space or a capital letter here is not cosmetic -- it silently returns an empty queue, which
 * looks identical to "nothing is wrong" and is the worst possible answer to a triage screen.
 *
 * Validated client-side for the message, not to protect the API: the server requires the
 * parameter and scopes every query with it, and this function cannot widen what it is allowed to
 * ask for.
 */
export const normaliseShopDomain = (raw: string): ShopDomainResult => {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return { ok: false, reason: "Enter a shop domain, for example kinetous.myshopify.com." };

  // Strip a scheme and anything from the first path separator onwards. Doing this before the
  // emptiness check means `https://` alone is rejected as the malformed thing it is, rather than
  // passing as an empty domain.
  const withoutScheme = trimmed.replace(/^(https?:\/\/|\/\/)/, "");
  const host = withoutScheme.split(/[/?#]/, 1)[0] ?? "";

  if (host.length === 0) return { ok: false, reason: "That is not a shop domain. Try kinetous.myshopify.com." };
  if (/\s/.test(host)) return { ok: false, reason: "A shop domain cannot contain spaces." };
  // Every Shopify shop domain is a FQDN. This is a typo-catcher, not the security boundary --
  // `store` and `store.myshopify.com` are both safe to send, they simply are not both valid.
  if (!host.includes(".")) return { ok: false, reason: "That does not look like a shop domain. Try kinetous.myshopify.com." };
  if (host.length > 255) return { ok: false, reason: "That shop domain is too long." };

  return { ok: true, value: host };
};

export type ExceptionFilters = {
  readonly shopDomain: string;
  readonly statuses: readonly ExceptionStatus[];
  readonly severities: readonly ExceptionSeverity[];
  readonly types: readonly FulfillmentExceptionType[];
  readonly limit: number;
  readonly cursor?: string | null;
};

/**
 * Builds the query string for `GET /api/operations/exceptions`.
 *
 * Filters are repeated (`?status=open&status=resolved`) rather than comma-joined, because that is
 * the shape the API parses and the one `URLSearchParams.getAll` returns. An empty list is
 * omitted rather than sent empty, since the API treats a present-but-empty value differently
 * from an absent one -- `?status=` is a validation error, and omitting it gets the documented
 * default of open-only.
 *
 * `shopDomain` is always included, including when it is the only thing set. The API requires it
 * and a request without it is a 400, not a default.
 */
export const buildExceptionQuery = (filters: ExceptionFilters): URLSearchParams => {
  const params = new URLSearchParams();
  params.set("shopDomain", filters.shopDomain);

  for (const status of filters.statuses) params.append("status", status);
  for (const severity of filters.severities) params.append("severity", severity);
  for (const type of filters.types) params.append("type", type);

  params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);

  return params;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A short relative age, for the queue's "age" column.
 *
 * Relative because the question this column answers is "is this fresh or has it been sitting
 * here?" -- an absolute timestamp answers that only by making the reader do arithmetic.
 *
 * A timestamp in the future renders as `just now` rather than a negative age. That is not
 * cosmetic leniency: database and browser clocks disagree, and a row that reads "-4m ago"
 * implies a bug in our data that may not exist. The absolute time is still available in the
 * cell's tooltip, so the information is not lost, only the misleading part of it.
 */
export const formatAge = (iso: string, now: number): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";

  const elapsed = now - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
};

/**
 * An absolute UTC timestamp, for tooltips and for anything that must be unambiguous.
 *
 * Formatted in UTC by hand rather than with `toLocaleString`. `toLocaleString` depends on the
 * runtime's locale and time zone, so the same exception renders as two different strings on the
 * server and in the browser -- React's hydration mismatch, showing up as a console error and a
 * flash of the wrong content. A queue that operators compare against a UTC audit log should not
 * render in the reader's local time anyway; two operators in different zones reading the same
 * incident should see the same clock.
 */
export const formatTimestamp = (iso: string): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const MAX_DETAILS = 140;

/**
 * Flattens an exception's `details` into one short line for the table.
 *
 * `details` is a JSON column with a different shape per exception type, and a triage screen has
 * room for a line, not a JSON viewer. Anything unrecognised degrades to its JSON text rather than
 * to an empty cell, because an empty cell reads as "no further information" when it actually
 * means "this UI has not been taught this type yet".
 */
export const summariseDetails = (details: unknown): string => {
  if (details === null || details === undefined) return "";
  if (typeof details !== "object") return String(details);
  // An array is an object to `typeof`, so without this it renders as its indices -- "0: a · 1: b"
  // -- which reads like a schema and tells an operator nothing. `details` should always be a
  // record, so this only fires on a shape the domain does not produce, and the useful thing to do
  // with an unexpected shape is show the values.
  if (Array.isArray(details)) return details.map(String).join(", ");

  const parts: string[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (parts.length >= 3) {
      parts.push("…");
      break;
    }
    parts.push(value !== null && typeof value === "object" ? `${key}: {${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k} ${String(v)}`).join(", ")}}` : `${key}: ${String(value)}`);
  }

  const line = parts.join(" · ");
  return line.length > MAX_DETAILS ? `${line.slice(0, MAX_DETAILS - 1)}…` : line;
};

/**
 * Human labels for the vocabularies, in one place so the UI does not invent its own wording.
 *
 * `SEVERITY_LABELS` is `Record<ExceptionSeverity, string>` rather than a plain object on
 * purpose: the type is a lookup table over the union, so adding a severity to the domain fails
 * this file's typecheck until it has a label. A `Record<string, string>` would have accepted the
 * missing key silently and rendered `undefined` into a severity badge.
 */
export const SEVERITY_LABELS: Readonly<Record<ExceptionSeverity, string>> = {
  blocking: "Blocking",
  warning: "Warning",
};

export const STATUS_LABELS: Readonly<Record<ExceptionStatus, string>> = {
  open: "Open",
  resolved: "Resolved",
  ignored: "Ignored",
};
