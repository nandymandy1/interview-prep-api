# Interview Prep API — Express + TypeScript Foundation

A production-minded Express.js starter for the interview-prep assessment. It keeps Express explicit while borrowing the useful discipline of NestJS: constructor injection, clear layers, typed request validation, centralized exception handling, and an application composition root.

## Stack

- Express.js 5
- TypeScript (strict)
- express-validator
- Mongoose / MongoDB
- Redis
- express-session + connect-redis
- Pino structured logging
- Vitest + Supertest

## Core architecture

```text
HTTP request
  -> request context + lifecycle logger
  -> auth / validation middleware
  -> wrapRoute(...)
       -> lazy singleton controller provider resolves on first use
       -> controller
       -> service
       -> repository / integration
  -> response
```

Construction is centralized in `src/container/app-container.ts`.

Application classes are provided through lazy singleton providers. A controller is not constructed when a route is registered; `wrapRoute` resolves the provider only when the route is actually executed.

### Hard dependency rule

`new Service(...)`, `new Repository(...)`, and `new Controller(...)` belong in the application container only. A service must never import the container. Dependencies are explicit through constructor dependency objects.

```ts
new AuthService({
  userRepository: userRepository(),
  passwordService: passwordService(),
  logger: loggerService(),
});
```

This means any service can reuse another service without becoming a service locator: add the dependency to the service's constructor type and wire it in the container.

## Router pattern

```ts
router.post(
  '/login',
  loginValidator,
  validationMiddleware,
  wrapRoute(authController, 'login', 'auth.login'),
);
```

`authController` is a `Provider<AuthController>`, not an already-created controller.

## Exceptions

Throw typed HTTP exceptions from controllers/services/repositories:

```ts
throw new BadRequestException('Your error message goes here');
```

Common exception classes are in `src/common/errors/http-exception.ts`.

For expected exceptions, the client gets the original message and correct status code:

```json
{
  "success": false,
  "message": "Your error message goes here"
}
```

Validation errors may additionally include `details`.

Unknown/internal errors are logged with the request context but return a generic `Internal server error` message so internal details are not leaked.

`wrapRoute` logs route failures itself and writes the error response. Errors raised before a wrapped route runs (for example auth/validation/404 middleware) are handled by the global error middleware using the exact same response formatter.

## Request logging

Every request receives an `x-request-id`. `AsyncLocalStorage` keeps that request context available through controllers, services, repositories, and integrations without manually threading request IDs through every method.

Lifecycle logs include:

- request id
- user id when authenticated
- HTTP method + path
- route operation
- status code
- handler duration
- total request duration
- errors

Sensitive headers/passwords are not deliberately logged. Never add secrets, raw session IDs, auth headers, or full passwords to log metadata.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

Required local services:

- MongoDB
- Redis

Then:

```bash
curl http://localhost:4000/health
```

## Useful commands

```bash
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
npm run check
```

## Included example feature

The `auth` module demonstrates the full pattern:

```text
auth.router.ts
  -> auth.controller.ts
  -> auth.service.ts
  -> user.repository.ts
  -> user.model.ts
```

Routes:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Session data is stored in Redis.

## Adding a new module

For a `kit` module, prefer only the layers it actually needs:

```text
src/modules/kit/
  kit.router.ts
  kit.controller.ts
  kit.service.ts
  kit.repository.ts
  kit.model.ts
  kit.validator.ts
  kit.type.ts
```

Do not create empty layers purely to satisfy a pattern.

Then add lazy providers to `app-container.ts`, add route dependency mapping in `router-dependencies.ts`, and register the router in `routes/index.ts`.

## Interview kit pipeline (assessment)

Overview: paste a job description + company URL + days → `POST /api/kits` persists a
queued kit and enqueues one BullMQ job → a worker thread researches, generates via
Gemini, validates, repairs coverage, schedules, and persists → frontend polls
`GET /api/kits/:kitId/status` → builder edits → flashcard practice.

- Queue: one `kit-generation` BullMQ queue, `jobId = kitId` (never double-enqueue),
  `attempts = 1`, worker `concurrency = 1`.
- Worker thread: BullMQ `useWorkerThreads` with the external compiled processor
  (`dist/modules/generation/kit-generation.processor.js`). Boot the API from `dist`
  (`npm run build && npm start`); dev must build first or the worker refuses to start.
  Same deployment — no second service; needs Node `worker_threads` allowed.
- Progress: Redis Pub/Sub channel `kit-generation-progress` is best-effort only.
  Mongo kit `status`/`stage` is the source of truth for `GET /status`.
- Brave Search (2 req/s plan): every HTTP attempt passes a shared start gate
  (`BRAVE_MIN_REQUEST_INTERVAL_MS = 600`, Redis `SET NX PX` across API/worker,
  in-process gate in the evaluator), ≤3 sequential queries, 2 attempts, 429/backoff
  respected. Absent key → structured unavailable, never fabricated.
- LLM: one Gemini provider (`GEMINI_API_KEY`, `GEMINI_MODEL`), Axios,
  `responseMimeType: application/json`, Zod-validated, 2 attempts.
- Retrieval: Axios-only hardened client (SSRF DNS binding, `proxy: false`, 15s total
  deadline, redirect scope/robots guards, robots.txt respected, Cheerio extraction,
  content marked `external-untrusted`, prompts treat JD/research as data).
- Generation sequence: JD-only requirement extraction (IDs in code) → company research
  → brief + flashcards (one call) → four separate category calls → deterministic
  coverage + exactly one repair pass (final uncovered MUST is `[]`) → deterministic
  schedule for the exact day count → canonical validation.
- Editor preservation: `pinned`/`edited`/`manual` question flags and edited brief fields
  live in `editorMeta` outside the strict canonical kit; regeneration replaces only
  unedited content and reuses high-water IDs.
- Practice: completed kits only; weakest-first (unpractised → lowest confidence →
  original order); confidence persists via practice records.
- Evaluator (no Mongo/BullMQ/auth): `npm run evaluate -- --input <cases.json> --output
  <kits.json>` reuses the same `KitGenerationService` sequentially and writes
  `{version: "1.0", generated_at, kits}` Appendix B output.

Env: `PORT, FRONTEND_ORIGIN, MONGODB_URI, REDIS_URL, SESSION_SECRET,
BRAVE_SEARCH_API_KEY (optional), GEMINI_API_KEY, GEMINI_MODEL`.

Known limitations: regeneration re-runs live research (costs Brave quota per click);
single worker means one kit generates at a time; Pub/Sub progress can drop messages
(`GET /status` stays correct).
