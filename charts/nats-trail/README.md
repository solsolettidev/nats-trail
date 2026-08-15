# NATS Trail Helm chart

```bash
helm install nats-trail ./charts/nats-trail -f my-values.yaml
```

## Declaring the deployment

The point of this chart is that an operator declares the instance rather than clicking it into
existence. Contexts and correlation keys defined in `values.yaml` are asserted on every start, and
the API refuses to edit or delete them — so the chart stays the source of truth and a redeploy can
never be silently diverged from.

```yaml
config:
  contexts:
    - id: prod
      name: Production
      environment: prod
      url: nats://nats.default.svc:4222
      auth:
        type: userpass
        username: nats-trail
        password: ${NATS_PASSWORD}   # resolved from the container environment

envFrom:
  - secretRef:
      name: nats-trail-credentials   # supplies NATS_PASSWORD
```

Credentials never go in the ConfigMap. `${VAR}` is resolved at startup from the environment, so
structure lives in the chart and secrets live in a Secret. **An unset variable stops the deployment**
rather than connecting with a blank password.

Check what landed, including unresolved variables, without shelling in:

```bash
curl http://nats-trail/api/config
```

## Why a StatefulSet with one replica

Local state — contexts, saved filters, the correlation index — lives in SQLite on the volume. A
second replica would corrupt it. A debugging tool does not need horizontal scale, and shipping a
Deployment that breaks quietly the first time someone runs `kubectl scale` would be worse than
saying so.

## Authentication

There is none built in, on purpose. The UI and local API have no login; identity is delegated to
whatever already fronts the service — an ingress with OIDC, oauth2-proxy, Cloudflare Access,
Teleport, or network isolation. That is the only approach that fits every environment this has to
run in, and it means there are no passwords stored here to leak.

Bearer tokens still gate the Integration API and the WebSocket:

```yaml
auth:
  existingSecret: nats-trail-tokens   # key NATS_TRAIL_TOKENS: "ci:tok-read,ops:tok-write:write"
```

Tokens are read-only unless granted the `write` scope.

## Readiness does not depend on NATS

A NATS outage is exactly when someone needs this tool. Making the pod unready then would take it
away at the worst moment, so the probes only report whether the process is serving.
