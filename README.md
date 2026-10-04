# Kinetous Fulfillment Operations Platform

An e-commerce fulfillment and operations automation platform. It connects commerce
platforms (Shopify), fulfillment providers (3PL/WMS), and carriers, and turns the messy
workflows between them into observable, retryable, auditable operations.

This repository is a Bun + Turborepo monorepo built to be **read and extended**, not just
consumed. Architectural decisions are documented inline at the point where they matter,
so you can see *why* each boundary exists.

---

## Table of contents

- [Stack](#stack)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Commands](#commands)
- [Environment variables](#environment-variables)
- [Architecture](#architecture)
- [Package responsibilities](#package-responsibilities)
- [Current state](#current-state)
- [Data flow: Shopify order ingestion](#data-flow-shopify-order-ingestion)
- [Data flow: routing an order](#data-flow-routing-an-order)
- [Data flow: the routing worker](#data-flow-the-routing-worker)
- [Data flow: the operations queue](#data-flow-the-operations-queue)
- [The operations console](#the-operations-console)
- [Local ports](#local-ports)
- [Testing](#testing)
- [Deployment](#deployment)

---

## Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript 7 (strict) |
| Runtime / package manager | Bun 1.4+ |
| Monorepo orchestration | Turborepo 2 |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS, shadcn/ui |
| API | Hono 4 on Bun |
| Database | PostgreSQL (Neon) + Drizzle ORM + Drizzle Kit |
| Auth | Better Auth |
| Validation | Zod 4 |
| Background jobs | Trigger.dev 4 |
| Email | Resend |
| AI | Vercel AI SDK (introduced only after the deterministic system works) |

Deliberately absent: no NestJS, no Python backend, no second ORM, no second auth system,
no second job runner, no Kafka/Redis/Kubernetes, no event sourcing, no premature
multi-tenancy.

---

## Prerequisites

- [Bun](https://bun.sh) >= 1.4.0
- A PostgreSQL database. The current `.env` points at a Neon instance; a local
  `postgresql://postgres:postgres@localhost:5432/kinetous_fulfillment` works equally well.
- (Optional) A Trigger.dev account, only needed once real background tasks exist.

---

## Setup

```bash
bun install
cp .env.example .env     # then fill in the values
bun run db:migrate       # apply migrations
bun run dev              # start every app
```

### Why the root `.env`

There is exactly **one** env file, at the repository root, and every entrypoint resolves
it explicitly. This is not incidental — it fixes a real class of silent failure:

> Turborepo runs each task with `cwd` set to the *package* directory, not the repo root.
> So `apps/api` sees `apps/api/.env`, `packages/db` sees `packages/db/.env`, and a root
> `.env` is invisible to both. Environment variables simply vanish, with no error.

Rather than duplicating `.env` into every package (and creating four files that drift
and four places to leak a secret from), `packages/validation/src/environment-loader.ts`
walks up from its own module location until it finds the `package.json` that declares
`"workspaces"`, and loads that file. It is independent of `process.cwd()`, so it works
under Turbo, plain `bun run`, and `bunx` alike.

| Entrypoint | How it loads the root `.env` |
| --- | --- |
| `apps/api/src/server.ts` | `loadRepositoryEnvironment()` |
| `packages/db/drizzle.config.ts` | `loadRepositoryEnvironment()` |
| `apps/web/next.config.js` | `loadEnvConfig()` from `@next/env`, pointed at the root |
| `packages/tasks` (`bun run dev`) | `bun --env-file=../../.env` |

### Environment precedence

```
1. real process environment   (Vercel / CI / Docker)   <- highest
2. repo-root .env             (local development)
3. schema default             (e.g. API_PORT=4000)
```

`dotenv` never overwrites a variable that is already set, so a real deployment
environment always wins over the local file.

### Turborepo and environment variables

Turborepo 2 defaults to `envMode: "strict"`, which **strips any variable not declared in
`turbo.json`**. Without declarations, `DATABASE_URL` and friends are `undefined` inside
every task — silently. All variable *names* are therefore declared in `turbo.json`
(`globalEnv` / `globalPassThroughEnv`); only names are committed, never values.

Secrets are declared in `globalPassThroughEnv` rather than `globalEnv` on purpose:
`globalEnv` feeds the task's cache hash, and secret material should not influence a cache
key that may be uploaded to a remote cache.

---

## Commands

All commands are Bun-based. There is no pnpm in this repository.

```bash
# Root
bun run dev          # every app in parallel via turbo
bun run build
bun run lint
bun run typecheck
bun run test

# Database (owned by @repo/db)
bun run db:generate  # generate a migration from the Drizzle schema
bun run db:migrate   # apply pending migrations
bun run db:push      # push the schema directly (prototype only, no migration history)
bun run db:studio    # Drizzle Studio

# Single package
bun run --filter=@repo/api dev
bun run --filter=@repo/db typecheck
```

### Migrate vs push

- `db:migrate` is the correct default. It applies committed SQL files and records history
  in the `drizzle` schema, so the database can be rebuilt from scratch and team members
  converge on the same schema.
- `db:push` diffs live state against the schema and mutates it directly. Convenient while
  prototyping, but it leaves no migration file, so it cannot be reproduced or reviewed.
  Use it only in throwaway databases.

---

## Environment variables

Server-only variables must never be exposed through a `NEXT_PUBLIC_` prefix — those are
inlined into the browser bundle at build time.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | yes | — | Better Auth signing secret, min 32 chars |
| `BETTER_AUTH_URL` | yes | — | Origin the auth API is served from (the Hono API) |
| `API_PORT` | no | `4000` | Hono API listener port |
| `WEB_APP_URL` | no | `http://localhost:3000` | Dashboard origin, trusted for cookie auth |
| `NEXT_PUBLIC_API_URL` | yes | — | Base URL the dashboard calls (public) |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `SHOPIFY_WEBHOOK_SECRET` | no | — | HMAC secret for Shopify webhooks |
| `TRIGGER_SECRET_KEY` | no | — | Trigger.dev project key |
| `RESEND_API_KEY` | no | — | Email delivery |
| `THREE_PL_API_KEY` | no | — | 3PL provider |
| `SHIPPO_API_KEY` | no | — | Carrier/tracking |

Schemas live in `packages/validation/src/environment.ts`, split by runtime context
(`databaseEnvironmentSchema`, `serverEnvironmentSchema`, `publicEnvironmentSchema`) so
that `db:push` does not fail on a machine with no auth secret.

---

## Architecture

The organising principle: **business logic is independent of frameworks.**

```
Shopify ──webhook──► Hono ──► application ──► domain
                         │          │            │
                      validate   ports      pure rules
                         │          │            │
                         └──────────┴──► PostgreSQL
                                      │
                                      └─► JobDispatcher ──► Trigger.dev ──► 3PL
```

Allowed direction of travel:

```
apps/web  ──►  packages/application  ──►  packages/domain
apps/api  ──►  packages/application  ──►  packages/domain
                       ▲
                       │  (implements the port)
                 packages/db
```

Two rules make this real:

1. **Hono is an HTTP boundary, not a place to put logic.** A route validates, then calls
   an application use case. Routes exist for genuine HTTP boundaries (webhooks, public
   API, machine-to-machine), not because CRUD is expressible.
2. **Application use cases do not know they are being called from HTTP.** The same use
   case is callable from a Hono route, a Next.js Server Action, a Trigger.dev task, or a
   future CLI — with no HTTP round trip in between.

### Ports and adapters

`packages/application` declares the interfaces it needs; `packages/db` and
`packages/integrations` implement them. This is why `@repo/db` depends on
`@repo/application` and **not** the reverse: the port belongs to the business logic, the
adapter is swappable infrastructure.

```ts
// packages/application — the port
export interface ShopifyOrderWebhookRepository {
  claimDelivery(input: {...}): Promise<WebhookDeliveryClaim>;   // own transaction
  applyOrder(input: {...}): Promise<AppliedOrder>;               // one transaction
  recordFailure(input: {...}): Promise<void>;                    // own transaction
}

// packages/db — the adapter
export function createShopifyOrderWebhookRepository(db: Database): ShopifyOrderWebhookRepository
```

Note the asymmetry, because it is the whole design. The claim and the failure record each
commit on their own; only the order, its items, the audit row, and the terminal status
share a transaction. If the claim shared one with the work it guards, a failure would roll
the record back too and we would have no evidence the delivery ever arrived.

The same shape applies to background work. The business layer says *dispatch a
fulfillment job*, not *call the Trigger.dev API*:

```ts
// packages/application/src/fulfillment-job-dispatcher.ts
export interface FulfillmentJobDispatcher {
  dispatch(input: { fulfillmentId: string; idempotencyKey: string }): Promise<void>;
}
```

Trigger.dev is just one implementation of that interface, imported **type-only** by
consumers so that a request never drags the Trigger SDK into its dependency graph.

---

## Package responsibilities

| Package | Owns | Must not depend on |
| --- | --- | --- |
| `apps/web` | Next.js dashboard: Server Components, Server Actions, client components | business rules |
| `apps/api` | Hono HTTP boundary: webhooks, public API, Better Auth handler | business rules |
| `packages/application` | use cases and orchestration, port interfaces | Hono, Next.js, React, Trigger.dev |
| `packages/domain` | business concepts, state machines, invariants | every framework |
| `packages/db` | Drizzle schema, client, migrations, repository adapters | business rules |
| `packages/integrations` | Shopify / 3PL / carrier adapters | business rules |
| `packages/validation` | Zod schemas and the typed env boundary | anything app-specific |
| `packages/auth` | Better Auth configuration | app files |
| `packages/tasks` | Trigger.dev tasks (thin: task → use case) | business rules |
| `packages/email` | Resend client and email templates | — |
| `packages/ui` | genuinely shared UI only | — |
| `packages/db`, `packages/typescript-config`, `packages/eslint-config` | shared tooling config | — |

Internal packages are always imported by name (`@repo/domain`), never by relative path.
Every package declares the dependencies it actually uses.

---

## Current state

**Phase 1 (foundation), Phase 2 (order ingestion), Phase 3 (domain model), Phase 4 (routing
engine), Phase 5 (the routing worker), and Phase 6 (operations visibility — the API and the
console) are complete.** Working today:

- Monorepo, workspaces, Turbo task graph, TypeScript across all 13 packages
- Typed environment boundary with a single root `.env` and explicit per-entrypoint loading
- PostgreSQL via Drizzle, migrations applied, relational query API working
- Better Auth with email/password, cross-origin cookie sessions verified
- Hono API with request IDs, structured error envelope, `/health`, `/api/auth/*`,
  `POST /webhooks/shopify/orders`
- Shopify HMAC signature verification and topic-aware payload validation
- Two-phase webhook processing: claim, apply, and record failures
- Idempotency enforced by unique constraints, with an audit event per accepted order
- A framework-independent error taxonomy with a `retryable` flag driving HTTP status
- **A dependency-free domain model**: branded identifiers, `Money`, the order lifecycle,
  address shippability, stock levels, and the exception taxonomy
- **A routing engine that cannot oversell**: country-priority warehouse selection, an
  all-or-nothing basket rule, and stock reserved atomically under row locks
- Warehouse, inventory, reservation, and exception tables with their invariants as CHECK
  constraints
- **A routing worker that actually runs**: a Trigger.dev cron drains the routable queue every
  five minutes, and a manual trigger does the same on demand
- **An operations API for the exception queue**: shop-scoped, operator-gated, keyset-paginated
  reads and a compare-and-set close that records who decided what
- **A dashboard that renders it**: sign in, pick a shop, triage the queue, close entries with a
  recorded reason — reading the API from the browser with a credentialed CORS grant
- Trigger.dev task package with a working local worker
- Lint, typecheck, test, and build green across every package

**Not yet built** (each is a later phase): real 3PL integration, shipments, the AI layer, and
per-shop membership. The highest-value next step is a per-shop membership table, because the
operator allow-list is currently a grant to read every merchant's data, and shipping is the
natural next capability now that an order can be routed and its failures can be seen.

### The routing engine

Two halves, and the split is the point.

`selectWarehouse` in `@repo/domain` is pure: given a country, a SKU basket, and the candidate
sites, it returns a warehouse or a reason, with no I/O, no clock, and no randomness. Four
rules, applied in order:

1. **An ineligible order is rejected first.** A test order, an incomplete address, or a
   shippable line with no SKU cannot be routed, and searching harder will not fix it.
2. **Country is a hard filter.** A site not responsible for the destination is not a candidate
   at any price, so a German warehouse is never chosen for a New Zealand order merely because
   it has more stock.
3. **One site covers the whole basket.** Splitting is a legitimate strategy, but it has to be
   chosen deliberately with knowledge of cost, not discovered as a side effect of a loop.
4. **Priority, then warehouse id.** Deterministic, so a re-run routes the same order to the
   same site and "why did this go to Rotterdam?" stays answerable.

`createOrderRoutingRepository` owns the transaction, and its step order **is** the concurrency
design:

1. Lock the order row (`FOR UPDATE`) — also the idempotency guard.
2. Short-circuit if already allocated, cancelled, or not a candidate.
3. Find active sites responsible for the destination country.
4. Lock those sites' inventory rows for the basket's SKUs, ordered by `(warehouse, sku)`.
5. Decide, using only the locked rows.
6. Write: decrement, insert reservations, mark allocated — or insert an exception.

The obvious alternative is read stock, decide, then write. It fails under load in a specific
way: another request can commit a reservation after the read and before the write, so this
request allocates against stock that was never available. Locking before deciding closes the
gap by putting the read and the write on the same row locks. The row ordering matters for the
same reason — two requests needing SKUs A+B and B+A would otherwise deadlock, and Postgres
resolves that by killing one of them.

The contention test pins this: ten orders in parallel compete for three units, and exactly
three are allocated. Removing the lock makes that test fail with seven aborted transactions, so
the test is not merely asserting "no oversell" — which the CHECK constraint would catch
anyway — but the actual guarantee.

### The domain model

`packages/domain` holds the business rules and has **zero dependencies** — no framework, no
ORM, no validation library. That is what lets the routing engine, a Trigger.dev job, and an
HTTP handler ask the same questions of the same objects and get the same answers. It is also
why 159 of the 325 tests run in 45ms instead of needing a database.

| Module | What it owns |
| --- | --- |
| `identifiers.ts` | `OrderId`, `Sku`, `WarehouseId`, … branded types with validating factories |
| `money.ts` | `Money` as integer minor units, with per-currency exponents |
| `order-status.ts` | the lifecycle as a transition table, plus terminal and cancellable states |
| `address.ts` | `classifyShippability` — a judgement, not an exception |
| `stock.ts` | `StockLevel` with `available` derived, and `findShortfall` |
| `exceptions.ts` | the exception taxonomy, severity, and the resolution audit trail |
| `order.ts` | the `Order` aggregate root and its guarded transitions |

Three decisions in there are worth knowing before reading the code.

**Brands, not aliases.** `OrderId` and `WarehouseId` are both `string` at runtime, so there
is no serialisation cost, but the compiler will not let you pass one where the other belongs.
That turns a swapped-argument bug from a foreign-key violation at 3am into a build error.

**`available` is derived, never stored.** Storing `onHand`, `reserved`, and `available` as
three columns means three numbers that can disagree, and they will when a concurrent
reservation is interrupted. An oversell is not a rounding curiosity. `StockLevel` holds two
counters and computes the third, so the inconsistent state cannot be represented.

**Judgements return; malformed input throws.** A missing city or a missing SKU is not a bug in
the software — it is a real order that needs a human. `Order.problems()` and
`classifyShippability()` return data; only genuinely malformed input throws
`ValidationFailedError`. Throwing on a business outcome would fail the job and lose the
order, which is the opposite of what should happen.

### Current database schema

Thirteen tables, from `drizzle/0000_green_electro.sql` through `0004`:

| Table | Purpose |
| --- | --- |
| `users`, `sessions`, `accounts`, `verifications` | Better Auth |
| `orders`, `order_items` | ingested commerce orders, with ship-to address, cancellation state, and allocation warehouse |
| `webhook_events` | every inbound webhook: status, attempts, error reason, raw payload |
| `audit_events` | append-only trail of state changes |
| `warehouses`, `warehouse_routes` | sites, and which countries each serves at which priority |
| `inventory` | per-site, per-SKU `on_hand` and `reserved` |
| `inventory_reservations` | what is held for which order, and whether it is still held |
| `exceptions` | durable operator queue: type, severity, status, resolution audit |

`fulfillments`, `fulfillment_items`, `shipments`, and `shipment_events` will be added by the
phases that need them, not speculatively.

Three choices here are worth stating, because each looks like an omission until it bites:

- **`inventory.available` is not a column.** Three stored counters can disagree, and they will
  when two reservations touch one row and one aborts. `available` is computed as
  `onHand - reserved`, and the CHECK constraint makes the inconsistent state unstorable.
- **Priorities live in `warehouse_routes`, not on `warehouses`.** A regional hub is nearest to
  its own country and furthest from the next one; a single priority per site forces one of the
  two routings to be wrong, invisibly.
- **`orders.allocated_warehouse_id` has no foreign key.** A warehouse FK would point back at
  `orders`, and a two-file import cycle between schema modules is a fragile thing to build a
  correctness argument on. The CHECK that an allocated order names a warehouse is the
  constraint that matters; the FK can be added once either table moves.

### Integrity rules enforced by the database

Rules that span a transaction cannot be guaranteed by application code, so they are CHECK
constraints. Adding one to a table that already violates it **fails the migration** — which
is the correct outcome, because it means you find out your data is inconsistent instead of
quietly accepting it.

| Constraint | Rule |
| --- | --- |
| `webhook_events_status_check` | status is one of `received`, `processing`, `processed`, `failed` |
| `audit_events_event_type_check` | event type is one of the five order events |
| `orders_cancelled_requires_timestamp_check` | an order claiming to be cancelled has a cancellation time |
| `orders_status_lifecycle_check` | status is one of the eight `ORDER_STATUSES` in `@repo/domain` |
| `orders_allocated_requires_warehouse_check` | an allocated order names its warehouse |
| `inventory_reserved_within_on_hand_check` | `reserved` never exceeds `on_hand` |
| `inventory_reservations_order_sku_active_unique` | one active reservation per order and SKU — the re-routing guard |
| `exceptions_resolution_audit_check` | a closed exception says who closed it and why |

The status list is restated in SQL rather than imported, because a CHECK cannot take bind
parameters. That duplication is a real cost, and `orders.test.ts` pays it back by asserting
the two lists match, so a new domain state cannot be added without the database accepting it.

---

## Data flow: Shopify order ingestion

```
Shopify
  │
  │  POST /webhooks/shopify/orders
  ▼
Hono route                                   ← HTTP boundary only
  │  1. read required headers                 (hmac, -webhook-id, -shop-domain, -topic)
  │  2. verify HMAC over the RAW body         (timing-safe; a re-serialised body must fail)
  │  3. refuse an unimplemented topic         (422; never guess what a payload means)
  │  4. Zod-parse the payload
  ▼
processShopifyOrderWebhook()                 ← application use case, framework-independent
  │
  ├─ buildOrderIntent()                      ← policy: topic + payload → desired order state
  │     assertIntentIsCoherent()             ← reject a policy violation before the DB
  │
  ▼
claimDelivery()                              ← OWN transaction
  │  5. INSERT webhook_events (status='processing') ON CONFLICT DO NOTHING
  │       └ no row   ⇒ claimed  → continue
  │       └ row.status='failed'  ⇒ retry    → continue   (Shopify is retrying our failure)
  │       └ row.status='processed' ⇒ already_processed → return 200, do nothing
  │
  ▼
applyOrder()                                 ← ONE transaction
  │  6. INSERT orders ON CONFLICT DO UPDATE   (xmax = 0 tells insert from update)
  │       └ status/cancelled_at/cancel_reason are FROZEN if already cancelled
  │  7. DELETE then INSERT order_items       (Shopify is the system of record)
  │  8. INSERT audit_events
  │  9. mark webhook_events.status = 'processed'
  ▼
HTTP 200 { accepted, duplicate, created, orderId, webhookEventId, auditEventType }
```

**Idempotency** is enforced in the database, not in application code, so it holds across
concurrent deliveries and multiple API instances. Two unique constraints do the work:
`webhook_events(provider, external_event_id)` catches redelivery of the same event, and
`orders(shop_domain, shopify_order_id)` catches a different webhook describing an order that
already exists.

Three details are load-bearing and easy to get wrong:

1. **A failed delivery is retried, not acknowledged.** The claim returns
   `claimed | already_processed | retry`. A boolean `duplicate` flag cannot express this:
   a delivery we genuinely failed at looks identical to one we finished, and acknowledging
   it as a duplicate would lose the order permanently with no error anywhere.
2. **The claim commits before the work.** A crash mid-processing leaves
   `status = 'processing'` as evidence. If the record rolled back with the failure, an
   incident would be undebuggable.
3. **Cancellation is terminal, and enforced in SQL.** The application cannot see the
   order's current status, so it cannot know that an `orders/updated` delivery is for an
   order cancelled seconds ago. Status, timestamp, and reason are frozen together in the
   upsert; the only way out is a new order.

### Failure handling

| Situation | HTTP | Webhook event | Shopify retries? |
| --- | --- | --- | --- |
| Bad or missing HMAC | 401 | not recorded | no |
| Unsupported topic | 422 | not recorded | no |
| Payload fails validation | 422 | not recorded | no |
| Policy invariant violated | 422 | `failed` + reason | no |
| Database unreachable | 500 | `failed` + reason | yes |
| Already processed | 200 | `processed`, `attempts` incremented | no |

Nothing is recorded for an unauthenticated request — otherwise an anonymous caller could
fill the table with rejected deliveries.

The status codes are derived from the error's `retryable` flag rather than chosen per
case, which is the reason that flag lives on the error. A 5xx is an instruction to come
back; a 4xx says the identical bytes will be rejected identically, so retrying wastes
everyone's time and hides the problem. A permanently invalid payload is quarantined as
`failed` with a reason an operator can read, rather than vanishing.

---

## Data flow: routing an order

Triggered by the next phase (a Trigger task, or an operator action). The trigger does not
exist yet, which is deliberate: routing is a use case with a persistence port, and a
scheduled job that calls it is not part of what makes the allocation correct.

```
routeOrder({ orderId })
  │
  ├─ BEGIN
  ├─ SELECT orders … FOR UPDATE              ← serialises concurrent routing of THIS order
  ├─ already allocated? → return the existing allocation, write nothing
  ├─ cancelled / test / past allocation? → not_routable, no exception
  ├─ basket empty? → not_routable, no exception
  ├─ SELECT warehouse_routes ⨝ warehouses     ← active sites for the destination country
  ├─ SELECT inventory … ORDER BY … FOR UPDATE  ← locks candidate stock in a fixed order
  ├─ selectWarehouse(...)                     ← pure policy, locked data only
  │
  ├─ routed      → decrement each SKU with a WHERE available >= qty guard,
  │                insert active reservations, set status = allocated + warehouse,
  │                append ORDER_ALLOCATED
  │
  └─ unroutable  → insert one open exception, leave the order pending
  │
  └─ COMMIT
```

Two things are worth noting about the failure paths.

A basket is **never partially reserved**. If any SKU cannot be covered, the transaction rolls
back every increment made so far, so there is no state in which an order holds stock it can
never ship. And a cancelled order is not an exception: raising one would fill the operator
queue with "no warehouse" rows for orders that are on purpose not shipping.

### Concurrency

`FOR UPDATE` on candidate stock is what makes this safe, and it is easy to write the same
code without it:

```ts
const stock = await readStock(warehouseId, skus);   // ← race starts here
const decision = selectWarehouse(requirements, stock);
await reserve(decision.warehouseId, decision.reservation);
```

Two requests for the last unit both read `reserved = 0`, both decide yes, and both commit.
The `reserved <= on_hand` CHECK turns the oversell into an error rather than bad data, but the
user-visible result is still wrong: some orders fail with an opaque constraint error instead
of being told the warehouse is out of stock, and the retry storm makes it worse.

Locking before deciding removes the window instead of containing it. Row locks are taken in
`(warehouse, sku)` order so that two requests needing SKUs A+B and B+A cannot deadlock — and
because a deadlock is resolved by Postgres killing one of the transactions, an unordered lock
would turn a correct design into an intermittent production failure.

---

## Data flow: the routing worker

Phase 4 built the capability and left it unreachable, which is worth naming: a fully tested
function that nothing calls is not a feature. This phase is the call site.

```
Trigger.dev cron, every 5 minutes          manual trigger
        │                                        │
        └──────────────► runRoutingPass(repository) ◄──┘
                              │
                              ├─ listRoutableOrderIds(50)
                              │     └─ orders_routable_idx: pending, not a test order,
                              │        oldest first. A partial index, so this stays an
                              │        index-only scan as the table fills with history.
                              │
                              └─ for each order → routeOrder(…)      ← the Phase 4 transaction
                                       │
                                       ├─ any order threw? collect it, keep going
                                       └─ after the batch, throw if anything was collected
```

Three decisions, each of which was the wrong answer first.

**A poller, not a call from the webhook handler.** Shopify expects an acknowledgement in a few
seconds. Routing takes row locks on the order and on every candidate inventory row for its
basket, so doing it inline means a slow query gets the request killed mid-transaction — the
lock wait is wasted and the order is still unrouted. Decoupling also narrows the blast radius: a
webhook failure is retried by Shopify, a worker failure by Trigger.dev.

**No claim step.** A worker that claimed a batch would need its own claim state to release on
crash. Phase 4 already made `routeOrder` idempotent and row-locked, so running the same order
twice is a no-op for the second caller. Claiming would be a second mechanism solving a solved
problem, and it would add a state that can be stranded — the exact failure Phase 2 had to
delete for webhooks.

**A failing order does not stop the batch, but it does fail the pass.** These are different
decisions and conflating them is how this goes wrong in production. An order whose row is
internally inconsistent throws on *every* attempt; in a loop that rethrows it occupies the head
of the oldest-first queue permanently and nothing behind it ever routes, with nothing logged as
an error. So the batch isolates failures. But a pass that swallowed them would report success
having routed nothing, which is the same outcome wearing a green badge — so `runRoutingPass`
throws after the batch finishes, and Trigger.dev retries. The retry is safe because routing is
idempotent.

---

## Data flow: the operations queue

Phase 4's routing transaction raises exceptions, and it does so correctly — in the same
transaction as the decision it describes. What was missing was the other end. This phase is the
read side, plus the fix that makes the table worth reading.

### The duplicate flood, found by building the reader

Designing the queue surfaced a bug in Phase 5 that no existing test could see. An unroutable
order keeps `status = 'pending'` — deliberately, because that is what lets a restock self-heal
on the next worker pass. But the worker runs every five minutes, so it re-evaluates the same
never-restocked order 288 times a day, and each evaluation inserted a *fresh* exception. One
out-of-stock order produced 288 identical queue entries per day, which buries every other problem
the operator has.

Both halves of that are individually correct, which is why it survived a phase. The fix is a
partial unique index:

```sql
CREATE UNIQUE INDEX exceptions_open_order_type_unique
  ON exceptions (order_id, type) WHERE status = 'open';
```

Partial on `status = 'open'` on purpose: re-raising after an operator closes an exception is
legitimate, and a blanket unique index would make the second occurrence a constraint error
instead. This way the history reads "happened, handled, happened again".

Enforced by the database rather than a pre-insert check in application code, because a
pre-insert check is a race that happens to be won by the row lock the routing transaction
already holds — correct today, silently wrong the day a second writer appears. The insert became
`onConflictDoNothing` against that index, and when it conflicts the worker reports the
*existing* exception rather than the freshly-built one, which never reached the database.

Verified both ways, not just through the repository: a raw second insert bypassing the
application is rejected naming that constraint, and a duplicate row with `status = 'resolved'` is
accepted, confirming the index is genuinely partial.

### The endpoints

```
GET  /api/operations/exceptions?shopDomain=&status=&severity=&type=&cursor=&limit=
POST /api/operations/exceptions/:id/close      { shopDomain, status, note }
```

Four decisions in that surface, each of which was the wrong answer first.

**`shop_domain` is required on every method, including the one taking a primary key.** Exception
ids are `exc_<timestamp>_<type>` — a timestamp and one of eight constants. They are guessable, so
an unscoped lookup by id is a cross-merchant read of customer names, addresses and order
contents, reachable by incrementing a number. The use case throws on a blank shop domain before
the repository is called, and the repository scopes its fallback read too — so an exception under
another shop answers `not_found`, never `already_closed`, which would confirm the id exists.

**A close is one statement, not a read-then-write.** Two operators working the same queue will
reach for the same entry. Read-then-write leaves a window where both read `open`, both write, and
the second note overwrites the first — destroying the audit trail the close exists to preserve. So
the UPDATE is conditional on `status = 'open'` and a zero-row result is the answer, which is also
the only way to tell "already closed" from "never existed" without a second read that could race
in turn. The loser gets a 409, not a silent success.

**The actor comes from the session, never the body.** `resolved_by` answers "who decided to ship
this order without stock?". An actor taken from a request body is an answer the caller chose,
which makes the column decorative. There is a test that passes a forged `actor` in the body and
asserts the session's identity won.

**Keyset pagination, not offset.** The queue is append-heavy and worked by a person paging
through it. Offset is wrong for exactly that: a new exception arriving between page one and two
shifts every row down, so the operator re-sees one they just handled and skips one they have not.
The cursor is `(created_at, id)` rather than `created_at` alone, because two exceptions written in
one transaction share `now()` and a timestamp-only cursor drops or repeats the boundary row. There
is a test with three exceptions sharing a timestamp for that reason.

### The operator gate, and what it is not

Better Auth runs with `emailAndPassword` enabled and no signup restriction, so "has a session" is
not a boundary for operational data: anyone who can register an account would otherwise read
every merchant's exceptions. `users` has no role column, so authorisation is an
`OPERATOR_EMAILS` allow-list, evaluated by `isOperator` in `@repo/auth`. It **fails closed** — an
unset list authorises nobody, because a missing variable defaulting to "allow all" turns a
deployment mistake into a breach.

Worth being explicit about the limit: this is a *staff* list, not tenant isolation. An operator
may name any `shopDomain`. Scoping by shop is what makes an accidental cross-shop read impossible
for a human clicking through, and it is the exact seam where a real per-shop membership table
goes. Before external operators are invited, that table is the change to make.

401 and 403 stay distinct, so the dashboard can tell "sign in" from "signed in, not allowed". The
session guard runs *before* query parsing, so an unauthenticated caller gets 401 for a malformed
request too — otherwise the response distinguishes well-formed from broken for someone who has
not proved they may ask.

---

## The operations console

`apps/web` was the Turborepo splash page. It is now the exception queue: sign in, name a shop,
read what routing could not complete, and close entries with a reason.

### Why the browser talks to the API directly

The obvious Next.js shape is a server component that fetches the queue and forwards the session
cookie by hand. That does not work here, and the reason is worth writing down before someone
"simplifies" it back.

The session cookie is `HttpOnly` *and* `SameSite=Lax`. A server component reading it would work on
localhost — cookies ignore ports, so `localhost:3000` and `localhost:4000` are the same site — and
break the moment the two are deployed to different subdomains, where the browser sends the API's
cookie to the API and not to the dashboard. The dashboard would render an empty queue for a signed
in operator, and nothing in the logs would say why.

So the console fetches from the browser with `credentials: "include"`, and CORS on the API grants
exactly `WEB_APP_URL` and `BETTER_AUTH_URL`. That works in every topology, and needs the cookie to
be *sent* rather than *read*, which is the part that matters: `HttpOnly` is a security property we
keep rather than one we work around.

**The deployment consequence:** the dashboard and the API must be on the same *site*. `app.` and
`api.` under one registrable domain is fine. `kinetous.com` and `kinetous.dev` is not — `Lax` will
withhold the cookie and every request will 401. Crossing sites needs
`SameSite=None; Secure`, which in turn means HTTPS everywhere and a real CSRF decision, because a
`None` cookie is sent to any site. That is why the allow-list and the shop scoping are not
optional extras to be tidied away once the dashboard looks good.

### CORS is hand-written, on purpose

Hono's `cors` middleware sets its headers *before* awaiting the handler, and Hono builds a new
response object when a handler throws. So every error response came back without
`Access-Control-Allow-Origin` and the browser reported "CORS error" instead of the message.

That is not a rare path. It is the 401 on a signed-out dashboard's first load, the 403 for an
account that is not an operator, the 409 when an operator loses a close race, and every 400. The
API's error envelope exists to tell an operator what went wrong and which request to quote, and
this bug discarded all of it in favour of the one message that helps nobody. `apps/api/src/cors.ts`
applies the headers again after the handler runs, and `cors.test.ts` asserts them on a thrown
error, because the unit tests that only exercise the success path cannot see this class of bug at
all.

The origin list is derived from the same two variables as Better Auth's `trustedOrigins`, fails
closed when either is missing or malformed, and never falls back to `*` — `credentials: true` plus
a wildcard is rejected by browsers *and* would be no security boundary if it were not.

### The shop is not tied to the account

There is no membership table, so the operator list grants access to *every* merchant and the
console asks which shop to look at, remembering the last one in local storage. The API still scopes
every read and every close by `shopDomain`, so nothing leaks between shops; what is missing is the
*authorisation* per shop. Until that exists, `OPERATOR_EMAILS` is a list of people who can read
every merchant's customer names, addresses and order contents, and the console says so on screen.

### What the tests cover, and what they cannot

`apps/web` has a test script now — 51 tests over the pure logic: shop-domain normalisation, query
building, age and timestamp formatting, and the client's error mapping. All of it runs without a
browser, a server or a database, which is the point of keeping it out of the components.

What those tests cannot do is prove the console renders, which is why the vertical slice was
verified against a running API and a real exception instead: list, reject a note-less close with
400, close with the actor taken from the session, then get 409 on the second close. The seeded
order, exception and two test accounts were removed afterwards, and the repository `.env` was
restored.

---

## Local ports

| Service | Port | URL |
| --- | --- | --- |
| Dashboard (Next.js) | 3000 | http://localhost:3000 |
| API (Hono) | 4000 | http://localhost:4000/health |
| Trigger.dev local worker | 5000 | — |

`API_PORT` is read by `apps/api/src/server.ts`. It must differ from the dashboard port;
when they collided previously the API silently bound 3000 and one of the two apps crashed
with `EADDRINUSE` at startup.

---

## Testing

```bash
bun run test                                  # every package
bun run --filter=@repo/domain test            # 159 tests, ~45ms, no database
bun run --filter=web test                     # 51 tests, no browser or server
bun run --filter=@repo/validation test
bun test packages/db/src/schema/relations.test.ts
```

Tests live next to the code they cover and run on Bun's test runner. Priorities, in order
of value to this project:

1. **Domain tests** — the lifecycle, stock invariants, money, shippability
2. **Application tests** — process order, create/retry fulfillment, exceptions
3. **Integration tests** — webhook processing, idempotency, database behaviour
4. **API tests** — auth, validation, webhook signatures, HTTP behaviour
5. **Worker and API tests** — that a failed pass is loud, an idle one is not, and the
   operations guards cannot be bypassed
6. **Console tests** — shop-domain normalisation, query building, and error mapping, all without a
   browser. The one thing they cannot prove is that the page renders, which is why the vertical
   slice was also driven against a running API and a real exception

325 tests across 8 packages. Current coverage is behavioural and protects real decisions:
the order lifecycle and its terminal states, the stock reservation invariants, exact money
arithmetic across currency exponents, what makes an address unroutable, warehouse selection
and ranking, HMAC verification, the environment boundary, the error taxonomy, the ingestion
policy and its invariants, error code to HTTP status mapping, and — against a real database —
idempotency, failure recording, retry-after-failure, concurrent delivery, atomic
non-overselling under ten-way contention, the routable queue's ordering and filters, and the
CHECK constraints. Tests are added when they protect a decision, not to raise a coverage number.

Two of them are worth singling out, because they are the reason a green suite here means
something:

- **The contention test** runs ten orders in parallel against three units and asserts exactly
  three allocations and zero thrown errors. It was checked by removing the row lock and
  confirming it fails, because a concurrency test that passes either way documents nothing.
- **The queue-ordering test** asserts oldest-first rather than asserting the queue works. A
  backlog is exactly when ordering matters, and a newest-first worker looks identical to a
  correct one on a quiet queue — the bug only appears under the load that made it worth fixing.
- **The close-race test** fires two closes at one exception concurrently and asserts exactly one
  wins, that the loser is told, and that the surviving note is one of the two rather than a
  blend. A half-written audit trail is worse than none, because it looks complete.
- **The dedupe test** asserts the *count*, not the content, because the count is the whole
  defect. It also asserts a closed exception does not block a genuinely new one for the same
  order, which is the property a blanket unique index would have taken away.
- **The loud-failure test** pins the asymmetry that motivated the worker: one bad order must
  not stop the batch, and the batch must still fail. Both halves are asserted, because
  implementing only the second turns a stuck order into a silent stall and only the first turns
  it into a queue that stops moving.
- **The schema/domain agreement test** reads CHECK constraint definitions back out of the live
  database and compares them to the domain's status lists. The SQL list has to be restated as a
  literal because a CHECK cannot take bind parameters, and Drizzle's `sql.join` writes it as
  `in ('$1','$2')` — a constraint that looks right in the source and rejects every row.

The domain suite is the one to run constantly. At 159 tests in 45ms it costs less than
saving a file, and it needs no database, no network, and no fixtures, so there is never a
good reason to skip it.

### Test runtime

`bun run test` takes roughly **two minutes**, almost all of it the `packages/db`
integration suite. That is the database, not the tests: measured against this Neon
instance, the first query costs ~2.1–2.7s (it scales to zero and must resume) and each
round trip after that costs ~300–500ms.

For a fast inner loop while iterating:

```bash
SKIP_DB_INTEGRATION=1 bun run test
```

Run the full suite before calling a phase done. The DB tests skip themselves cleanly with
a reason if the database is unreachable, rather than reporting a false failure.

The client deliberately uses `prepare: false`. Prepared statements would roughly halve the
warm query time (measured: 280ms vs 524ms) but break behind a transaction-mode pooler such
as PgBouncer, where the session that created a prepared statement may not be the one that
later uses it. Two minutes of honest slowness is cheaper than a driver error that only
appears in production, behind a proxy nobody touched.

---

## Deployment

| Component | Target |
| --- | --- |
| `apps/web` | Vercel |
| `apps/api` | any Bun-capable host (Fly.io, Railway, Cloudflare Containers) |
| `packages/tasks` | Trigger.dev Cloud |
| Database | Neon (PostgreSQL) |

`apps/api` builds to a single bundled file (`bun build ./src/server.ts`) and starts with
`bun run start`.

For deployment, set real environment variables in the host's dashboard rather than
shipping a `.env` file — precedence already guarantees the host wins.

---

## Security notes

- Never log API keys, auth secrets, passwords, or tokens.
- Never put a secret behind a `NEXT_PUBLIC_` prefix; those are compiled into the browser
  bundle.
- Webhook payloads are authenticated by HMAC over the **raw** request body, compared in
  constant time. Re-serialising the body before verifying invalidates the signature, so
  verify first and parse second.
- Do not echo unvalidated input back in an error message. The webhook endpoint names the
  topics it supports instead of repeating the topic it received.
- API error responses carry a fixed message per error code, never the domain error's own
  message. Domain messages are written to be safe, but that is a convention that decays;
  a fixed string cannot. Field-level detail belongs in the logs, keyed by `requestId`.
- `.env` is gitignored. `.env.example` is the committed template and must never contain
  real values.
