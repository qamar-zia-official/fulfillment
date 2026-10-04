Kinetous — Agent Engineering Contract

1. Mission

Kinetous is a production-oriented fulfillment operations platform for Shopify businesses.

Its job is to orchestrate the operational lifecycle between:

Shopify → Kinetous → WMS/3PL → Carrier → Customer
and back again for tracking, exceptions, returns, refunds, exchanges, and inventory reconciliation.

Kinetous is NOT the storefront, checkout, payment processor, warehouse execution system, or carrier. It is the orchestration and operational intelligence layer.

The current product is WEB ONLY.

2. Your First Rule: Inspect Before You Change

Before writing code:

Inspect the repository structure.

Inspect the relevant app/package.

Inspect package.json/workspace configuration.

Inspect existing patterns for routing, database access, validation, authentication, UI, errors, logging, and tests.

Identify the existing implementation that is closest to the requested change.

Reuse existing abstractions before creating new ones.

Do not assume a library is installed merely because it is listed in this document.

Do not replace an existing pattern with your preferred pattern without a concrete reason.

The repository is the source of truth for implementation details.
This document is the source of truth for engineering intent and permanent rules.

If repository reality conflicts with this file:

do not silently rewrite the architecture;

report the conflict;

explain the tradeoff;

ask for approval when the conflict affects architecture, security, data model, or external contracts.

3. Product Flow

The intended fulfillment lifecycle is:

Shopify order
→ webhook
→ Hono boundary
→ verify/authenticate
→ idempotency/deduplication
→ validate
→ persist
→ Trigger.dev task
→ determine fulfillment requirements
→ find eligible warehouses
→ check inventory
→ apply business rules
→ routing algorithm
→ choose warehouse
→ choose fulfillment path
→ WMS/3PL
→ pick/pack
→ shipment
→ carrier/tracking
→ Kinetous DB
→ Shopify/customer UI

Returns extend the lifecycle:

customer/order
→ return request
→ eligibility
→ return routing
→ return shipment
→ return warehouse
→ inspection
→ condition/disposition
→ restock / repair / dispose
→ refund / replacement / exchange
→ exchange may create a new fulfillment

4. Architecture

Preferred conceptual dependency direction:

web / api / worker
↓
application
↓
domain
↓
db / integrations / validation

External systems enter through adapters.

Examples:

Shopify → Shopify adapter → application/domain
3PL/WMS → provider adapter → application/domain
Carrier → carrier adapter → application/domain

Do not put business logic in HTTP handlers, React components, Server Actions, or Trigger.dev task wrappers.

HTTP handlers are transport adapters.
Trigger.dev tasks are execution/orchestration adapters.
React components are presentation.
Application use cases coordinate work.
Domain code owns business rules and state transitions.
Integration adapters own provider-specific behavior.
DB code owns persistence.

Do not create internal HTTP calls merely to invoke a background task. Trigger.dev/shared application code can call the appropriate application/domain functionality directly.

5. Expected Stack

The project context currently identifies:

TypeScript

Next.js

React

Hono

Better Auth

PostgreSQL

Drizzle

Trigger.dev

Zod

Tailwind

shadcn/ui

Base UI

Motion

AI SDK

Resend

Bun

Git/GitHub

Important: the actual repository wins. Verify installed versions and existing usage before introducing or changing anything.

Do not add dependencies casually.

Before adding a dependency, answer:

Why is it necessary?

Does the repo already solve this?

Is there a platform/native solution?

What maintenance/security/runtime cost does it add?

6. Monorepo Intent

Preferred structure:

apps/
web/ # Next.js operations dashboard
api/ # Hono HTTP boundary
worker/ # Trigger.dev/background jobs

packages/
db/
auth/
validation/
domain/
application/
integrations/
ui/
config/

Do not create a generic packages/utils dumping ground.

If the existing repository differs, preserve the existing structure unless a change is justified and approved.

7. Domain Boundaries

Shopify owns

storefront

checkout

payment

commerce/order source

Kinetous owns

operational orchestration

routing

fulfillment orchestration

integrations

exceptions

returns

inventory reconciliation

operational state

audit trail

WMS/3PL owns

physical warehouse execution

Carrier owns

transport

shipment movement

tracking events

Prefer event/webhook-driven synchronization.

Preferred:

3PL/WMS → webhook/event → Kinetous → DB → Shopify

Polling is a fallback when a provider lacks usable webhooks/events.

8. Warehouse Routing Rules

Never implement routing as simply:

“choose the nearest warehouse.”

First establish eligible warehouses using relevant constraints such as:

required inventory

destination coverage

service coverage

warehouse rules

capacity

safety stock

business constraints

Only then optimize among eligible candidates using factors such as:

shipping cost

SLA

distance

business priority

carrier/shipping constraints

Routing logic belongs in the domain/application layer, not the HTTP layer.

9. Security Is a System Property

Treat every external boundary as untrusted.

Untrusted inputs include:

URL params

query params

headers

cookies before session verification

JSON/form bodies

file uploads

webhook payloads before signature verification

third-party API responses

user-controlled identifiers

Ask:

Who are you?

Are you allowed to do this?

Is this input valid?

Are you allowed to access THIS organization/object?

Can this operation safely happen?

Authentication is not authorization.

Every organization-scoped resource must be tenant-scoped server-side.

Never trust organization IDs supplied by the client.

Never expose privileged writable fields through blind object spreading.

Never put secrets, SQL, stack traces, credentials, internal hostnames, or raw provider/database errors in API responses.

10. Request Classes

Browser API

request
→ request ID
→ CORS
→ authentication
→ CSRF where applicable
→ authorization
→ validation
→ application use case

Shopify/provider webhook

request
→ request ID
→ body-size limit
→ raw-body signature verification
→ durable deduplication/idempotency
→ validation
→ persist event
→ enqueue/background processing
→ fast 2xx

Do not use CORS as webhook authentication.

Verify Shopify signatures against the raw body and use timing-safe comparison where applicable.

Machine-to-machine API

request
→ authentication
→ authorization
→ schema validation
→ rate limits
→ application

Background job

validated execution context
→ validated payload
→ idempotency
→ authorization/context
→ timeout/retry policy
→ application use case

11. Validation

Use runtime validation at trust boundaries.

Zod is the expected validation mechanism where the repository already uses it.

Validate:

path params

query params

relevant headers

JSON bodies

form data

environment variables

webhook payloads after authentication

external API responses

TypeScript types do not replace runtime validation.

Treat third-party API responses as untrusted.

12. Idempotency and Distributed-System Rules

Never blindly retry mutations.

Important mutations include:

fulfillment creation

shipment creation

refund

inventory adjustment

external writes

email where duplicate delivery matters

Use durable idempotency/deduplication.

Prefer database-enforced uniqueness where possible.

Webhook delivery must be safe under:

duplicates

concurrent duplicates

replay

retries

partial failure

Assume requests and jobs can run concurrently.

Ask what happens if:

DB succeeds but provider fails;

provider succeeds but DB update fails;

the same webhook arrives twice;

two workers process the same order;

a provider times out after accepting a mutation;

a job retries after partial completion.

13. State Machines

Do not allow arbitrary state assignment such as:

{ "status": "fulfilled" }

Use explicit commands/use cases such as:

ProcessOrder

RouteOrder

CreateFulfillment

CreateShipment

RetryFulfillment

CancelFulfillment

ResolveException

ReconcileInventory

A state transition should verify:

actor/context

authorization

current state

legal transition

business preconditions

14. Transactions and Outbox

Use transactions when atomicity is required, not automatically for every request.

For coupled state/event changes, prefer the outbox pattern where appropriate:

BEGIN
→ lock/check relevant state
→ validate transition
→ update domain record
→ write audit/event record
→ write outbox event
COMMIT

Then process outbound effects asynchronously.

This prevents “database committed but event was lost” failure modes.

15. Error Handling

Domain/application layers must not depend directly on Hono.

Use application/domain errors.
Convert them to transport-specific HTTP responses at the API boundary.

Expected API semantics include:

400 malformed request

401 unauthenticated

403 authenticated but forbidden

404 missing/hidden resource

409 state/conflict

413 payload too large

415 unsupported media type

422 valid structure but invalid semantics

429 rate limited

500 internal failure

502 upstream failure

503 temporary unavailable

504 upstream timeout

Keep internal diagnostics in logs.

Use server-generated request IDs for authoritative tracing.

16. Observability

Production-oriented code should be designed for:

structured logs

request IDs

useful metrics

external API latency

DB latency

webhook failures

background-job failures

queue/backlog visibility

tracing across HTTP → application → DB → job → provider

alerts for significant failure conditions

Do not log secrets or sensitive customer data unnecessarily.

17. Database Rules

Use Drizzle and the existing repository patterns.

Prefer:

parameterized queries

explicit writable fields

tenant scoping

database constraints for invariants

indexes based on actual access patterns

migrations for schema changes

Never construct SQL by concatenating untrusted input.

Do not use request bodies as direct database update objects.

18. UI Rules

The current product is a web operations dashboard.

Use the UI system/components already established in the repository.

Before introducing a new UI primitive:

find the existing equivalent;

reuse it if appropriate;

follow existing spacing, typography, layout, form, table, modal, toast, and state patterns.

Do not redesign the application merely because you personally prefer another component library or visual style.

Do not invent mobile apps, React Native clients, desktop apps, or unrelated surfaces unless explicitly requested.

For UI work, inspect nearby screens and components first so the new UI looks native to the existing application.

19. Code Style / Maintainability

The goal is code that looks like it belongs in the existing codebase.

Prefer:

existing naming conventions

existing folder conventions

existing error patterns

existing data-access patterns

existing component patterns

small composable functions

explicit types at boundaries

narrow abstractions

clear domain names

Avoid:

speculative abstractions

giant files

generic helpers with unclear ownership

premature framework layers

duplicated business rules

unrelated refactors

clever code that obscures business behavior

Do not “clean up” unrelated code while completing a task.

20. Testing

Add tests at the appropriate level.

At minimum, consider:

domain/business-rule tests

application/use-case tests

integration tests for persistence/provider boundaries

API tests

authorization tests

idempotency/replay tests

concurrency-sensitive tests where relevant

UI/e2e tests for important user workflows

A task is not complete merely because TypeScript compiles.

Verify behavior.

21. Agent Workflow

For every task:

Phase A — Understand

Read:

this file;

relevant docs/ai/current-state.md;

relevant task file, if present;

relevant architecture/ADR/research notes;

relevant source code and tests.

Phase B — Investigate

Before changing code, identify:

existing implementation;

dependencies;

trust boundaries;

data flow;

failure modes;

tests;

likely affected files.

Phase C — Plan

For non-trivial work, state:

objective;

files likely to change;

implementation approach;

risks;

acceptance criteria;

verification commands.

If the requested implementation conflicts with architecture or security rules, stop and surface the conflict.

Phase D — Implement

Make the smallest coherent change that satisfies the task.

Do not rewrite unrelated files.

Phase E — Verify

Run the narrowest useful tests first, then broader verification.

Typical commands, only if they exist in the repo:

bun test

bun run lint

bun run typecheck

relevant package tests/builds

Inspect the final diff.

Phase F — Report

Return:

what changed;

why;

files changed;

tests/verification performed;

known limitations;

new concepts/dependencies introduced;

decisions that should become ADRs or research notes.

22. “New Concept” Rule

The developer explicitly wants to understand the system rather than receive foreign-looking code.

Whenever you introduce a concept that is new to the current project, call it out.

Examples:

outbox pattern

idempotency key

advisory lock

transaction boundary

new queue mechanism

new authentication mechanism

new provider abstraction

new caching layer

new UI state pattern

new dependency

new database constraint

new architectural layer

For each new concept, briefly explain:

what it is;

why this task needs it;

where it lives;

what tradeoff it introduces.

Do not introduce new concepts merely because they are fashionable.

23. Architecture Changes

Architecture changes require explicit reasoning.

Do not:

replace Hono;

replace Next.js;

replace Drizzle;

replace Better Auth;

replace Trigger.dev;

replace the UI system;

create a new major service;

introduce a new database;

create a new message broker;

move business logic across layers

without explaining the reason, alternatives, and consequences.

If the change is material, create/update an ADR.

24. Documentation State Model

Keep these concepts separate:

Permanent engineering rule → AGENTS.md

Architecture decision → docs/ai/decisions/

Current state → docs/ai/current-state.md

Research → docs/ai/research/

Task → docs/ai/tasks/

Learning → docs/ai/learnings.md

Do not put the entire project history into AGENTS.md.

The repository/Git is the durable project memory. Chat history is disposable.

25. Task Contract

When receiving a task, interpret it using:

Objective

What must become true?

Context

What existing code/state matters?

Constraints

What must not change?

Files

Which files/packages are relevant?

Acceptance Criteria

What observable behavior proves completion?

Verification

Which tests/checks prove it?

Open Questions

What remains uncertain?

If a task is underspecified but a safe implementation can proceed, make the smallest reasonable assumption and state it.
If the ambiguity could cause data loss, security problems, architectural drift, or a wrong external contract, stop and ask.

26. Hard Stops

Stop and ask before:

destructive data migrations;

deleting production data;

changing authentication/session semantics;

weakening authorization;

changing tenant isolation;

changing webhook signature verification;

changing external API contracts;

changing fulfillment/refund/shipment semantics;

adding major infrastructure;

introducing irreversible architecture;

hiding a failing test instead of fixing the cause.

Never bypass a security control merely to make a test or integration pass.

27. Final Principle

The agent's job is not:

“write code that looks plausible.”

The job is:

understand the existing system
→ make a justified change
→ preserve architectural invariants
→ verify behavior
→ explain what changed
→ leave the repository easier for the next engineer or agent to understand.

Prefer correctness, consistency, explicit tradeoffs, and verifiable behavior over speed of code generation.
