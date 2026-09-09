# AI Interview Prep Kit

Backend API + generation pipeline for the AI Interview Prep Kit
(Trao Full-Stack Engineering Assessment).

## Submission

Live application:
https://interview-prep-web-delta.vercel.app

Backend API:
https://nandy1.i-dacs.com

Frontend source:
https://github.com/nandymandy1/interview-prep-web

Backend source (this repository — primary submission, runs the mandatory evaluator):
https://github.com/nandymandy1/interview-prep-api

Walkthrough video:
[To be added before submission]

If the submission form accepts multiple repository links, submit BOTH. If it
accepts only one GitHub URL, use this backend repository: the mandatory
`npm run evaluate` entry point lives here.

## Overview

Paste a job description + company URL + days of preparation, and get back a
generated interview preparation kit:

JD + company URL + days
→ company research
→ JD requirement extraction (requirements come ONLY from the pasted JD)
→ company brief, flashcards, and per-category interview questions
→ deterministic coverage check (+ one targeted repair pass)
→ deterministic exact-day study schedule
→ editable builder (questions, brief, flashcards, schedule)
→ flashcard practice with confidence tracking

## Tech Stack

Backend:

- Node.js (>= 22), Express 5, TypeScript (strict)
- MongoDB / Mongoose (kit + status persistence)
- Redis / ioredis (sessions, BullMQ, rate-limit gate)
- BullMQ (generation queue + worker thread)
- Axios (retrieval + provider HTTP), Cheerio (page extraction)
- Brave Search (public interview-discussion research)
- OpenAI / Gemini adapters behind one `LlmGenerationAdapter` contract
- Zod (provider + canonical-kit validation), express-validator (HTTP validation)
- Vitest + Supertest

Frontend (separate repository):

- Next.js 16.3, React 19, Tailwind CSS v4, shadcn-style UI
- TanStack Query (server state), Zustand (client state), Axios (HTTP only)

## Architecture

```text
Browser
  ↓  same-origin /api rewrite (cookies stay first-party)
Next.js frontend (Vercel container)
  ↓  proxy to Express origin
Express API
  ├─ MongoDB            ← kit + generation status (source of truth)
  ├─ Redis / BullMQ     ← generation queue, sessions, Pub/Sub (best-effort)
  ↓
Generation worker (worker thread, same deployment)
  ├─ company-site crawler
  ├─ public interview-discussion research
  ├─ LLM (OpenAI or Gemini, configured)
  ├─ deterministic coverage check + repair
  └─ deterministic schedule builder
```

Request flow inside the API: request context + lifecycle logger → auth /
validation middleware → `wrapRoute(...)` (lazy singleton controller provider
resolves on first use) → controller → service → repository. Construction is
centralized in `src/container/app-container.ts`; a service never imports the
container — dependencies arrive through explicit constructor objects.

`GET /api/kits/:kitId/status` reads Mongo. Redis Pub/Sub progress
(`kit-generation-progress`) is best-effort only: a dropped message never
corrupts status.

## Research and generation sequence

The actual pipeline order (do not rely on any other description):

1. Company-site research (bounded crawl from the homepage, discovered and
   ranked links — never a fixed `/careers` guess)
2. Public interview/hiring discussion research (Brave Search, bounded queries)
3. JD-only requirement extraction (OpenAI; IDs allocated in code)
4. Company brief + flashcards (one call; flashcards reference ONLY listed
   `id [priority][kind]: text` mappings)
5. Question generation by category: technical, behavioural, system-design,
   company-fit (four separate calls; skipped entirely when zero requirements)
6. Deterministic coverage check (code compares question `requirement_ids`
   against requirement IDs — never model-decided)
7. Exactly one targeted repair pass for uncovered must-have requirements
8. Deterministic exact-day schedule
9. Canonical Zod validation + persistence

Requirements come only from the pasted JD. Company research informs the brief
and company-fit questions; it must never invent role requirements. Progress
stages: `queued → researching → analyzing-jd → generating → checking-coverage
→ building-schedule → completed`, persisted per stage — a failure keeps its
failed-at stage and the kit stays retryable via `POST /api/kits/:kitId/retry`
(same kit, same inputs, exactly one active job).

## Retrieval

- Company homepage crawl with discovered/ranked link following (bounded depth
  and page budget), robots.txt respected
- Hardened HTTP client: SSRF DNS binding, loopback/private ranges blocked in
  production, `proxy: false`, 15 s total deadline, redirect-scope guards,
  content-type and size limits, Cheerio text extraction
- Failed or skipped sources are reported per branch, never fabricated; one
  failed branch never destroys the other (research status:
  `complete | partial | failed`)
- Public discussion lookup: ≤3 sequential Brave queries, shared 600 ms start
  gate (Redis `SET NX PX` across API/worker, in-process gate in the evaluator),
  2 attempts with 429/backoff respected; absent key degrades to a structured
  unavailable result
- Research cache: 24 h by canonical URL + version + mode, company-generic
  (same company + different JD = research HIT, full generation MISS)
- All fetched text and the JD are treated as untrusted DATA inside prompts
  (never instructions); extracted content is marked `external-untrusted`

## LLM Provider

Submitted production provider:

Provider:
OpenAI

Model:
gpt-5.6-terra

Generation runs through the configured `LlmGenerationAdapter` (OpenAI chat
completions + `response_format: { type: "json_object" }`, or Gemini with
`responseMimeType: application/json`). Selection: `LLM_PROVIDER=openai|gemini`,
or auto-detect when exactly one key+model pair is configured.

- Bounded transient retries on the same provider: 429 (genuine rate limit),
  500/502/503/504, transient network errors — max 3 attempts, exponential
  backoff + jitter, `Retry-After` honored
- Never retried: 400/401/403, quota/billing exhaustion, invalid responses
- No automatic OpenAI→Gemini runtime fallback: a provider failure stays a
  provider failure, then the kit fails with a safe message
- Every provider JSON response is Zod-validated before use; API keys,
  Authorization headers, prompts, and JDs are never logged
- Whole-generation BullMQ job uses `attempts = 1` (provider/retrieval layers
  already bound their retries)

NEVER expose API keys. The repository ships with no provider/model configured;
production values live in deployment environment variables only.

## Coverage / Second Pass

Coverage is code-driven, not model-decided. After question generation,
`calculateCoverage` compares every question's `requirement_ids` against the
requirement IDs. Any uncovered must-have triggers exactly one targeted repair
call (uncovered requirements only), then coverage runs again. A kit whose
must-haves still lack coverage fails instead of shipping uncovered
(`coverage: { uncovered_requirement_ids: [], passes }` on success).

## Schedule

The schedule is deterministic: exactly the requested N days (1–60), integer
30-minute blocks per question, must-have material prioritized earlier, and
every scheduled `question_ids` entry references a real question. Thin kits
(zero requirements) still get the exact day count with honest empty days
(`Review available role and company context`, 0 minutes). Regenerating any
section rebuilds the schedule from all final questions.

## Builder State

`editorMeta` (question `pinned`/`edited`/`manual` flags, edited brief fields)
lives outside the canonical kit JSON. Manually edited or added content survives
category regeneration; regeneration replaces only untouched content, runs one
targeted coverage-repair pass when a must loses coverage (an unrepairable
regeneration fails WITHOUT saving), and continues high-water stable IDs
(`q3`, `f2`, … never reused). Builder writes carry the read `__v`: a stale
write is a structured 409 (`Kit changed; refreshing latest version.`), never a
silent clobber. All mutating routes accept `Idempotency-Key` (one UUID per
logical action; repeats replay instead of duplicating).

## Practice

Completed kits only: one flashcard at a time, weakest-first ordering
(unpractised → lowest confidence → original order; the deck reranks from
refetched state after every record so no card is skipped). Each card reveals
its answer, then records a 1–5 confidence score with SET semantics per
flashcard (a repeated PATCH leaves one logical record). Covered/uncovered
counts derive from recorded flashcards.

## Failure Handling

- Invalid/unreachable company or missing hiring pages: research degrades to
  honest `partial`/`failed` with per-branch failures; generation continues
  whenever a valid kit is still possible
- No public discussion results: partial research, brief says so honestly
- Thin JD (no extractable criteria): honest thin kit — possibly zero
  requirements/questions/flashcards, exact-day schedule, empty coverage
- Provider rate limit: transient 429s retry with backoff; quota exhaustion
  fails fast with a safe message; failed kits retry via the same kit ID
- Invalid model JSON: schema validation rejects it; malformed envelopes fail
  the job safely (never persisted as a kit)
- Duplicate generation: `Idempotency-Key` + `jobId = kitId` guarantee one kit
  and one active job per logical submission
- 1-day and 60-day schedules are covered by tests (exact day counts)

## Security

- Session auth (Redis-backed store); every kit route is owner-scoped
  (`findOwnedById` — no cross-user access)
- SSRF-hardened retrieval: DNS rebinding protection, private/loopback ranges
  blocked in production, redirect-scope + robots enforcement, content-type and
  size caps
- Fetched pages and pasted JDs are untrusted input, never instructions
- Secrets come from the environment only; logs never carry keys, auth headers,
  session IDs, passwords, prompts, or JDs
- Unknown errors return generic `Internal server error`; validation errors
  return structured details without internals

## Local Setup

```bash
git clone https://github.com/nandymandy1/interview-prep-api.git
cd interview-prep-api

cp .env.example .env
npm ci
```

Required local infrastructure:

- MongoDB
- Redis

Configure in `.env`: an LLM API key + model (`LLM_PROVIDER=openai` with
`OPENAI_API_KEY`/`OPENAI_MODEL`, or the Gemini pair), and optionally
`BRAVE_SEARCH_API_KEY` for discussion research.

Then:

```bash
npm run dev
```

Health:

```bash
curl http://localhost:4000/health
```

The worker thread runs inside the same deployment from compiled output: use
`npm run build && npm start` for generation (dev must build first or the
worker refuses to start — the API never listens half-capable).

## Batch evaluator

The mandatory assessment entry point. Reuses the SAME `KitGenerationService`
as the application, sequentially, continuing after individual failures.
No auth, no BullMQ, no MongoDB, no Redis connection for core execution
(placeholder infra values are never connected); localhost `company_url`
values are allowed in evaluation mode. Real LLM credentials are required;
without a Brave key, discussion research degrades to unavailable.

Exact command:

```bash
npm run evaluate -- --input <cases.json> --output <kits.json>
```

Input:

```json
[
  {
    "id": "case-01",
    "jd": "...",
    "company_url": "http://localhost:8099/acme/",
    "days": 5
  }
]
```

Output shape:

```json
{
  "version": "1.0",
  "generated_at": "...",
  "kits": [
    {
      "id": "case-01",
      "status": "ok",
      "kit": {},
      "error": null
    }
  ]
}
```

Failed cases report `"status": "failed"`, `"kit": null`, and an
`{ code, message }` error object. Canonical kit fields (`source`,
`company_brief`, `role`, `questions`, `flashcards`, `schedule`, `coverage`)
are identical to the application output — do not rename them.

## Deployment

- Backend: public Express deployment at `https://nandy1.i-dacs.com`
  (API + BullMQ worker thread in one service; needs Node `worker_threads`,
  MongoDB, Redis, provider keys via environment)
- Frontend: Vercel Container (`Dockerfile.vercel`, Next.js standalone,
  Node 22) at the live application URL above; `API_PROXY_TARGET` points at
  the backend origin and is baked at frontend build time
- Required backend environment: `NODE_ENV=production`,
  `PORT` (deployment-supplied), `FRONTEND_ORIGIN` (production web URL),
  `MONGODB_URI`, `REDIS_URL`, `SESSION_SECRET` (strong, 32+ chars),
  `SESSION_COOKIE_NAME=interview_prep.sid`, `LOG_LEVEL=info`,
  `BRAVE_SEARCH_API_KEY`, `LLM_PROVIDER=openai`, `OPENAI_API_KEY`,
  `OPENAI_MODEL=gpt-5.6-terra`, `GENERATION_CACHE_TTL_DAYS=7`,
  `RESEARCH_CACHE_TTL_HOURS=24`
- No secrets in the repository — see `.env.example` for the documented shape

## Tests

```bash
npm ci
npm run check     # typecheck + tests + lint + format:check + build
```

Focused suites: `test/generation.spec.ts` (pipeline order, thin JD, cache,
retry preservation), `test/builder.spec.ts` (preservation, concurrency,
sequence hydration), `test/kit-api.spec.ts` + `test/kit-retry.spec.ts` (HTTP
contracts, idempotency), `test/llm-adapter.spec.ts` (retry policy,
classification, request compatibility), `test/*research*.spec.ts`,
`test/crawl.spec.ts` (retrieval, robots, gates).

## Known Limitations

- One generation worker (`concurrency = 1`) favors provider/quota safety over
  throughput: one kit generates at a time
- Live generation depends on third-party LLM/research availability
- Pub/Sub progress is best-effort; Mongo status is authoritative
- Company research cache may temporarily return recent cached research
- Regeneration re-runs live research on a research-cache miss (costs Brave
  quota per click)
- Evaluator and live generation runs require real provider credentials

## Submission Links

Application:
https://interview-prep-web-delta.vercel.app

Backend API:
https://nandy1.i-dacs.com

Backend / evaluator repository:
https://github.com/nandymandy1/interview-prep-api

Frontend repository:
https://github.com/nandymandy1/interview-prep-web

Walkthrough video:
https://drive.google.com/file/d/11KwL8ugSSeCx9sIyq4DmFOCxlO14DlLn/view
