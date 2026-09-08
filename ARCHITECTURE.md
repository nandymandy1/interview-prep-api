# Backend Architecture

```text
Request
  -> request context/lifecycle logging
  -> session/auth/validation middleware
  -> router
  -> wrapRoute
       -> resolve lazy controller provider
       -> bind controller method
       -> log route timing/failure
  -> controller
  -> service
  -> repository / integration
  -> MongoDB / Redis / external service
```

## Composition

`createAppContainer(config)` owns dependency construction. Providers cache the first created instance.

Critical infrastructure (MongoDB and Redis connections) is explicitly resolved/connected at bootstrap so readiness failures happen before the server starts accepting traffic. Feature services/controllers remain lazy.

## Error path

- Controller/service/repository: `throw new BadRequestException(...)` etc.
- `wrapRoute`: logs route failure and sends typed response.
- Middleware failures before the wrapped handler: global error middleware logs and uses the same formatter.
- Unknown 5xx errors are never exposed to clients.

## Request context

`AsyncLocalStorage` carries request id, user id, method, and path through nested async service calls without manual request-context parameters.
