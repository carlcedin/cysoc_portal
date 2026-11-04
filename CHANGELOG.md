# Changes

## 1.0.3
- `MFA_REQUIRED` setting in `.env` (default `true`). When `false`, accounts sign in with a password only; staff see a warning banner, the server logs a warning, and each sign-in is audited as password-only.

## 1.0.2
- Portal containers can reach NTS, Grafana, email and SMS (they were on an internal-only network).
- nginx looks the app up again after it is recreated (no more 502 after restarts).
- HTTPS and HTTP ports set in `.env` (`PORTAL_HTTPS_PORT`, `PORTAL_HTTP_PORT`), for servers where 443 is already used.
- Optional Grafana stack in `grafana/`, reachable from the portal as `http://grafana:3000`.
- Integration errors name the real cause (DNS, timeout, refused, certificate) instead of "fetch failed".
- NTS endpoint ending in `/api/v2` is refused with an explanation.
- MFA: a reused code says so and no longer counts towards account lockout.
- `setup-env.sh` stops with a clear message when `.env.example` is missing, instead of leaving an empty `.env`.

## 1.0.1
- Setup scripts for `.env` and a temporary certificate; database start-up retries; esbuild server build.
