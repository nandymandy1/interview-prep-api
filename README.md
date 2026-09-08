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
