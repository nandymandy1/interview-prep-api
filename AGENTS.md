# Backend Engineering Rules

## Scope

This repository is an Express.js + TypeScript backend. Keep Express explicit; use NestJS-style discipline without decorators or hidden DI magic.

## Non-negotiable rules

1. TypeScript only. Keep `strict` mode green.
2. `src/container/app-container.ts` is the composition root.
3. Application controllers, services, and repositories are lazy singleton providers.
4. Do not import the application container from a controller/service/repository.
5. Dependencies are declared explicitly through constructor dependency objects.
6. Routers receive all lifecycle-sensitive dependencies through a typed router dependency object.
7. Route handlers use `wrapRoute(provider, method, operation)` so controller resolution is lazy and errors are logged consistently.
8. Request validation uses `express-validator` + `validationMiddleware`.
9. Business/application failures are thrown as typed `HttpException` subclasses.
10. Do not manually construct `{ success: false }` in feature code. Let the shared error responder do it.
11. Repositories own persistence details. Services own business logic. Controllers translate HTTP <-> application inputs/outputs.
12. Do not create a repository/controller file for a module that does not need one.
13. Use `LoggerService`; do not use `console.*` after bootstrap.
14. Never log passwords, cookies, authorization headers, session ids, API keys, or other secrets.
15. Add focused tests for behavior that is worth protecting.
16. Use `@/…` for every internal module import and export; `@/*` resolves to `src/*`. Relative paths are reserved for non-module assets only.
17. Use Zod for structured domain and generated-data validation. Keep `express-validator` for HTTP request middleware; do not add hand-written object-shape guards for new schemas.

## Dependency reuse

If `KitService` needs `ResearchService`, add it to `KitServiceDependencies` and wire it in `app-container.ts`.

Do not do this:

```ts
import { container } from '../../container';

container.researchService();
```

That is a service locator and hides the dependency.

A `Provider<T>` may itself be injected only when the dependency genuinely must stay lazy after the consumer is instantiated.
