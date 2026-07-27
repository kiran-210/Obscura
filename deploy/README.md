# Deploying the Obscura matcher (live, on a VPS)

The `matcher/` service is a **long-running Node process** — an in-memory order book plus a
`setInterval` matching loop that proves and submits `obscura-pool.match_orders` on Soroban.
That rules out Vercel (serverless, stateless). This stack runs it on any Docker host.

```
browser (HTTPS)  ──►  Caddy :443  ──►  matcher :8787  ──►  Soroban testnet
                      (TLS + CORS)     (book + prove + submit)
```

Two browser blockers are handled by Caddy, so the matcher source is untouched:
- **Mixed content** — the Vercel frontend is HTTPS and can't call an `http://` matcher → Caddy terminates TLS (auto Let's Encrypt).
- **CORS** — the matcher sends no CORS headers and 404s preflights → Caddy answers `OPTIONS` and adds `Access-Control-Allow-Origin`.

## Prerequisites

- A VPS with **Docker + Docker Compose v2**, ports **80, 443** open, ≥ **2 GB RAM** (UltraHonk proving via `bb.js` is memory-hungry).
- A **domain** with a DNS `A`/`AAAA` record pointing at the VPS IP (needed for the certificate).
- A **funded Stellar testnet secret** for the matcher's hot key.
- `deployments.json` present in the repo working tree (it's gitignored — it's already on your machine; make sure it's on the VPS too). The image bakes it in and targets `contracts.obscuraPoolMatchMemo` = `CA2CI7VKG27V3FIXD3OYXFYTN33DMI5QR4WFBX3N5SRC6JWEO3AWDILD` on testnet.

## 1. Fund the matcher key

```bash
stellar keys generate matcher --network testnet --fund   # creates + friendbot-funds
stellar keys secret matcher                              # prints the S… secret
```
No Stellar CLI? Any funded testnet keypair works — generate one and fund it at
`https://friendbot.stellar.org/?addr=<G...>`.

## 2. Configure

```bash
cp deploy/matcher.env.example deploy/matcher.env
# edit deploy/matcher.env: MATCHER_DOMAIN, CORS_ORIGIN (your Vercel origin), OBSCURA_MATCHER_SECRET
```

## 3. Launch (from the repo root)

```bash
docker compose --env-file deploy/matcher.env up -d --build
docker compose logs -f matcher      # expect: [matcher] listening on :8787 (mode=live, ... prover=NoirProver)
curl https://<MATCHER_DOMAIN>/health # {"ok":true,"orders":0,"mode":"live"}
```

If `prover=mock` shows instead of `NoirProver`, the compiled circuit wasn't found — it's
baked at `/app/circuits/match_orders.json`; rebuild with `--build`.

## 4. Point the frontend at it

On **Vercel → Project → Settings → Environment Variables**:

```
VITE_MATCHER_URL = https://<MATCHER_DOMAIN>
```
Redeploy the frontend. `matchingEnabled()` now returns true and placed orders are handed to
the matcher (`frontend/src/lib/matcher-client.ts`), which finds crosses and settles them.

## Trust / safety notes

- The matcher **sees order details but cannot steal funds** — every settlement note is a
  Poseidon2 commitment the circuit recomputes from the on-chain order preimages (see
  `matcher/README.md`). Fund the hot key with **testnet** XLM only.
- The `bb.js` SRS downloads on the first proof and is cached in the `bb-crs` volume, so
  restarts don't re-download it.
- Lock down CORS: set `CORS_ORIGIN` to your exact Vercel origin rather than `*`.

## Alternatives to Caddy

If you front the VPS with **Cloudflare** (proxied DNS) you already get HTTPS; you can drop
the `caddy` service and expose `matcher` on a port — but you still need CORS, so keep Caddy
or add the headers at your proxy. On the local network, run only `matcher` and test with
`curl http://localhost:8787/health`.
