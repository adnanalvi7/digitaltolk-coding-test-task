# Translation Management Service

An API-first service for storing, searching and exporting translations.

- **Stack:** NestJS 11 on Fastify, PostgreSQL 16 through Kysely, and Redis 7.
- **Locales** are data, not schema: a language is added with one API call.
- **Translations** are tagged by context (`mobile`, `web`, …) and searchable by key, content or tags.
- **The JSON export** for frontend i18n is always fresh, served pre-compressed from a versioned cache, and answers `304` without touching the database.



## 1. Quick start

### With Docker (recommended)

```bash
cp .env.example .env                 # optional; Compose has working defaults
docker compose up -d --build         # postgres + redis → migrate (one-shot) → app
                                     # every service has a healthcheck
                                     # host ports: PORT, POSTGRES_HOST_PORT, REDIS_HOST_PORT
                                     # (e.g. PORT=3100 POSTGRES_HOST_PORT=55432 REDIS_HOST_PORT=56379)

# Seed 200k translations and create the admin user (credentials come from your env):
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-random-password' \
  docker compose --profile seed run --rm seed
```

### Without Docker

You need Node ≥ 22.12, PostgreSQL 16 (with the `pg_trgm` and `citext` contrib extensions) and Redis ≥ 5.

```bash
npm ci
cp .env.example .env                 # set DATABASE_URL, REDIS_URL, ADMIN_EMAIL, ADMIN_PASSWORD
npm run build
npm run migrate
npm run seed -- --keys=50000 --locales=en,fr,es,de --tags=mobile,desktop,web --batch=5000 --fresh
npm start                            # http://localhost:3000, Swagger UI at /docs
```

The seeder takes `--keys`, `--locales`, `--tags`, `--batch`, `--seed` (PRNG seed) and `--fresh`. With `--fresh` it truncates the catalog tables and rebuilds the GIN indexes around the load.

- It is **idempotent**: re-running produces identical data.
- It **prints progress and the elapsed time**.
- On the reference machine it loaded 200,000 translations in **11.4 s** natively and **20.4 s** in the Compose stack (verified from a clean `docker compose down -v`).
- Swagger UI is on by default outside production. In production set `SWAGGER_ENABLED=true` to expose it; the Compose demo stack does.

### Try it

```bash
# 1. Exchange credentials for a token. The plaintext token is shown once.
TOKEN=$(curl -s localhost:3000/api/v1/auth/tokens -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"a-long-random-password","name":"cli"}' | jq -r .data.token)
AUTH="Authorization: Bearer $TOKEN"

# 2. Add a language. This is an INSERT, not a migration.
curl -s localhost:3000/api/v1/locales -H "$AUTH" -H 'content-type: application/json' \
  -d '{"code":"pt-BR","name":"Português (Brasil)"}'

# 3. Create a key with values and tags.
curl -s localhost:3000/api/v1/translations -H "$AUTH" -H 'content-type: application/json' \
  -d '{"key":"checkout.button.pay","values":{"en":"Pay now","pt-BR":"Pagar agora"},"tags":["web","mobile"]}'

# 4. Search by key prefix, content (word or substring), and tags.
curl -s "localhost:3000/api/v1/translations?key=checkout.&q=pay&tags=web,mobile&tagsMode=all" -H "$AUTH"

# 5. Export for Vue i18n. Fresh after every write; send the ETag back to get a 304.
curl -si "localhost:3000/api/v1/export/en?format=nested" -H "$AUTH" --compressed
curl -si "localhost:3000/api/v1/export/en?format=nested" -H "$AUTH" -H 'If-None-Match: W/"…"'
```

---

## 2. API

Every path has the prefix `/api/v1`. The full contract, with every DTO and status code, is in Swagger at `/docs` and in [`docs/openapi.json`](docs/openapi.json).

| Method | Path                      | Scope                                              | Notes                                                                                         |
| ------ | ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/auth/tokens`            | public, 5/min per IP+email                         | Returns a `tms_…` token once, with scopes ⊆ the user's scopes and an expiry                   |
| DELETE | `/auth/tokens/current`    | any token                                          | Revokes the calling token                                                                     |
| GET    | `/locales`                | `translations:read`                                |                                                                                               |
| POST   | `/locales`                | `locales:write`                                    | `201` + `Location`; the code is canonicalised (`pt-br` → `pt-BR`)                             |
| PATCH  | `/locales/:code`          | `locales:write`                                    | Rename, activate or deactivate                                                                |
| GET    | `/tags`                   | `translations:read`                                | Tags are created implicitly by translation writes                                             |
| GET    | `/translations`           | `translations:read`                                | `key` (prefix), `q` (content), `tags`, `tagsMode=any\|all`, `locale`, `cursor`, `limit` ≤ 100 |
| POST   | `/translations`           | `translations:write`                               | `{ key, description?, values: {locale: text}, tags? }` → `201` + `Location`                   |
| GET    | `/translations/:id`       | `translations:read`                                | One key with all its values and tags                                                          |
| PATCH  | `/translations/:id`       | `translations:write`                               | See the PATCH rules below                                                                     |
| DELETE | `/translations/:id`       | `translations:write`                               | `204`                                                                                         |
| GET    | `/export/:locale`         | `export:read`, or public when `EXPORT_PUBLIC=true` | `format=flat\|nested`, `tags`, `tagsMode`; raw JSON, `ETag`, `304`                            |
| GET    | `/health`, `/health/live` | public                                             | Readiness (Postgres + Redis) and liveness                                                     |

**PATCH rules for `/translations/:id`:**

- `values` merge by locale (an upsert). A `null` value removes that locale's translation.
- `tags` replaces the key's full tag set.
- `key` is immutable.

**Response conventions:**

- Success bodies are `{ "data": …, "meta"?: { "nextCursor", "limit" } }`.
- bigint ids are strings.
- Every error is RFC 7807 `application/problem+json` with a `requestId`. The status codes are 401 (with `WWW-Authenticate: Bearer`), 403, 404, 409, 413, 415, 422 (with field-level `errors`), 429 (with `Retry-After`) and 500. Bodies are generic and never contain SQL, table names or stack traces.

---

## 3. Running the tests

```bash
npm test              # unit tests (fast, no I/O)
npm run test:e2e      # e2e: real AppModule on Fastify against real Postgres and Redis
npm run test:cov      # unit + e2e with an enforced coverage gate (95/95/95/90)
npm run test:perf     # build, seed to 100k+ if needed, autocannon every endpoint, fail on any budget breach
npm run perf:explain  # EXPLAIN (ANALYZE, BUFFERS) of the exact SQL the repositories emit
npm run perf:export-build   # compares export build strategies and compression levels
npm run lint && npm run typecheck
```

The e2e tests use `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/translations_test`) and `TEST_REDIS_URL` (default `redis://localhost:6379/1`). The suite creates and migrates the test database itself. CI runs the same suites on Postgres and Redis service containers ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

`npm test` and `npm run test:e2e` have no coverage threshold, so a focused run never fails on coverage. The gate lives in [`jest.coverage.config.ts`](jest.coverage.config.ts) and applies to `test:cov`, which runs everything.

**What is covered** (413 tests, coverage 98.72% statements / 92.77% branches / 99.57% functions / 99.33% lines):

- **Every endpoint:**
  - the happy path
  - 401 with no, malformed, unknown, expired and revoked tokens
  - 403 with the wrong scope
  - 422 for each validation rule, including unknown fields
  - 404, 409, 413, 415, 429 and a leak-free 500
- **Search and pagination:**
  - search by key prefix (with `_` and `%` escaped), word, substring, locale filter, and tags in `any` and `all` modes
  - keyset pagination across pages and tampered cursors
  - matches that fall outside the probe window and sparse tag combinations, which exercise both branches of the adaptive plan
- **N+1 guard:** a query-counting Kysely plugin asserts that a page of 100 keys with values and tags costs exactly **1 statement**.
- **Abuse:** a flood of random bearer tokens from one IP gets 429 after the failure limit; credential spraying is throttled; a body that only _declares_ a large `Content-Length` gets 413.
- **Export freshness:**
  - after create, update, delete and locale deactivation, the new data appears immediately with a new ETag
  - a matching `If-None-Match` returns `304`
  - **a transaction that rolls back** (forced by a DB trigger) **never bumps the version**
  - a `409` never bumps it either
  - **self-healing:** a failed Redis publish is repaired by the reconciler, and a Redis version _ahead_ of Postgres is repaired by compare-and-set
- **CDN mode:** public versus private export headers, and a real HTTP purge call to a local server after a commit.
- **Platform:**
  - the OpenAPI document contains **every registered route** (discovered from Nest metadata, not a hand-written list)
  - all 4 migrations roll down and up cleanly
  - the seeder is idempotent and deterministic
  - the version stays monotonic after Redis data loss
  - repeated tagged writes do not consume tag ids (regression test for the sequence exhaustion bug)
- **Unit tests:**
  - formatters: key collisions, unicode, emoji, empty input, very deep keys, `__proto__` safety
  - the cursor codec, LIKE escaping and the problem mapper
  - token crypto, guards, services with mocked ports, and the version notifier
  - export cache, lock, coalescing and degraded-mode paths
  - shared utilities (`SingleFlight`, `latestOnly`, `BoundedLru`, cooperative mapping, hashing, type guards)
  - the cluster runner and log redaction

---

## 4. Architecture

```mermaid
flowchart LR
  C[Client / CDN] -->|HTTPS| F[Fastify + helmet + compress + CORS]
  F --> G["Global guards<br/>auth throttle → bearer (+ failure limiter) → scopes → api/export throttle"]
  G --> P["ValidationPipe (DTOs, 422)<br/>ParseBigIntIdPipe · LocaleCodePipe"]
  P --> CT["Controllers (thin)<br/>DTO → command → use case → response DTO"]
  CT --> S["Services / use cases<br/>(transactions, domain errors)"]
  S --> R["Repository ports<br/>(abstract classes = DI tokens)"]
  R --> K["Kysely repositories"] --> PG[(PostgreSQL 16)]
  S --> T["CatalogTransaction<br/>(records catalog_changes in-tx)"] --> PG
  T --> N["CatalogChangeNotifier<br/>(post-commit)"] --> V["VersionStore<br/>(Redis, set-if-greater)"]
  RC["VersionReconciler<br/>(every 5 s)"] -.-> V
  N -. debounced background .-> X["CDN purger · export warmer"]
  CT -.->|domain errors| E["ProblemDetailsExceptionFilter<br/>(RFC 7807)"]
  subgraph Export path
    EX[ExportService] --> EC["ExportCache: in-process LRU → Redis"]
    EX --> ER[ExportRepository] --> PG
    EX --> FM["ExportFormatter strategies<br/>flat · nested"]
  end
```

```
src/
  main.ts, app.factory.ts, app.module.ts   bootstrap and composition root (AppModule.forRoot(config))
  cluster/                                 node:cluster runner (APP_WORKERS), restarts crashed workers
  config/                                  zod-validated env → typed AppConfig (fail fast)
  common/                                  domain errors, problem mapper + filter, pipes, cursor, LIKE escaping, envelope/Swagger helpers,
                                           and framework-free building blocks: async/ cache/ crypto/ units, type guards
  database/                                Kysely factory (pool + server-side timeouts), migrations (up/down), generated types, transaction port
  redis/  catalog-events/                  Redis client; catalog change log, VersionStore, CatalogTransaction, notifier, reconciler
  auth/                                    tokens (+ verified-token cache), argon2id, guards, @Public/@RequireScopes, repositories
  throttling/                              pre/post-auth throttler guards, auth-failure limiter, atomic Redis (Lua) storage
  locales/  tags/  translations/           controllers, use cases, repository ports + Kysely implementations, DTOs
  export/                                  ExportService, formatter strategies, two-tier cache, CDN purgers, warmer
  health/  logging/  seeding/  cli/        terminus checks, pino config, deterministic seeder, migrate/seed/openapi CLIs
```

### Shared building blocks (`src/common`)

Cross-cutting mechanics are written once, unit tested in isolation, and have no Nest, Kysely or Redis imports:

| Utility                                              | Used by                                                            | What it replaces                                |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `SingleFlight<K, V>` (`async/single-flight.ts`)      | export builds, locale directory reloads                            | hand-rolled `Map<key, Promise>` coalescing      |
| `latestOnly(task, delayMs)` (`async/latest-only.ts`) | CDN purge and export warm subscribers                              | one purge and one warm per write during a burst |
| `mapCooperatively` / `yieldToEventLoop`              | flat and nested formatters                                         | a 50k-entry render blocking every other request |
| `BoundedLru` (`cache/bounded-lru.ts`)                | in-process export cache (weighted by bytes), verified tokens (TTL) | two separate LRU implementations                |
| `sha256Hex`, `shortDigest` (`crypto/hash.ts`)        | token hashing, throttler keys, export cache keys and ETags         | `createHash` calls scattered across modules     |
| `isRecord`, `stringProperty`, `numberProperty`       | cursor decoding, problem mapping, pg error mapping, validators     | unchecked casts of `unknown`                    |
| `units.ts` (`MS_PER_SECOND`, `ONE_MEBIBYTE`, …)      | config defaults, token cache, throttler storage, seeder            | magic numbers                                   |

SQL fragments that more than one repository needs are shared the same way: `tag-filter.sql.ts` gives both search and export the same `any` / `all` tag predicates.

### How SOLID shows up in the code

- **Single responsibility:**
  - Controllers only map DTOs to commands and responses.
  - Services own the use-case rules and the transaction boundaries.
  - Repositories contain only SQL.
  - Formatters are pure.
- **Open/closed and Liskov:**
  - Export formats are `ExportFormatter` strategies, collected by `ExportFormatterRegistry`. Adding YAML means adding a class and one provider entry.
  - `MemoryLayeredExportCache` _decorates_ any `ExportCache` without modifying it.
- **Interface segregation:** reads and writes are separate ports (`TranslationRepository` and `TranslationQueryRepository`). The export has its own `ExportRepository`. `CatalogChangeNotifier` (for writers) is separate from `CatalogChangeFeed` (for subscribers).
- **Dependency inversion:** services inject abstract classes (`{ provide: TranslationRepository, useClass: KyselyTranslationRepository }`) and a `TransactionRunner` port, so they never import Kysely or Fastify.

The full architecture decision record, with the ER diagram, endpoint table and risk register, is in [`docs/adr/0001-architecture.md`](docs/adr/0001-architecture.md).

---

## 5. Design decisions and trade-offs

**Fastify over Express.**

- Fastify has roughly twice Express's raw throughput.
- Its schema-aware JSON parser rejects `__proto__` and `constructor` poisoning.
- It gives tighter control over replies. The export sends a ready-made gzip buffer with `reply.send(buffer)`, so no interceptor re-serializes or re-compresses it.

**Kysely over an ORM.**

- The export reads 50k rows. Entity hydration would add cost without benefit, and hiding SQL works against an "optimized queries" goal.
- Kysely is a typed query builder, not a CRUD generator: every statement in `*.repository.ts` is written by hand and reviewable.
- DB types are generated from the migrated schema with `kysely-codegen`.
- Bulk writes use `INSERT … SELECT FROM unnest($1::…[], $2::…[]) ON CONFLICT …`, one statement no matter how many locales or tags are involved.

**PostgreSQL and its indexes.**

| Need                                     | Index                                                                                             | Why                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key prefix search, export `ORDER BY key` | `UNIQUE (key)` on a column declared `COLLATE "C"`                                                 | Keys are ASCII `[a-z0-9._-]`, so byte order is the right order. Under the C collation the unique b-tree serves `LIKE 'prefix%'` range scans directly, so a second `varchar_pattern_ops` index is unnecessary (one index fewer to maintain). |
| Word search                              | `GIN (search_vector)`, where `search_vector` is a generated `to_tsvector('simple', value)` column | `simple` is language-agnostic, because one stemmer cannot serve en, fr, es and zh at once.                                                                                                                                                  |
| Substring search                         | `GIN (value gin_trgm_ops)`                                                                        | Handles `ILIKE '%term%'`. Used only for terms of 3+ characters, since pg_trgm cannot index shorter ones.                                                                                                                                    |
| Export for one locale                    | `(locale_id, translation_key_id)`                                                                 | Narrows the scan to one locale.                                                                                                                                                                                                             |
| Batched hydration and upserts            | `UNIQUE (translation_key_id, locale_id)`                                                          | Serves `= ANY($ids)` and is the `ON CONFLICT` target.                                                                                                                                                                                       |
| Tag filters                              | `PK (translation_key_id, tag_id)` + `(tag_id, translation_key_id)`                                | Probe phase: per-key `EXISTS` on the PK. Set phase: `tag_id = ANY` on the second index, with `GROUP BY … HAVING count(*) = n` for `all`.                                                                                                    |
| Catalog version                          | `PK` on `catalog_changes.id`                                                                      | `max(id)` is a single index probe.                                                                                                                                                                                                          |

- **The baseline's `INCLUDE (value)` was deliberately dropped.** B-tree tuples are capped at about 2.7 kB, but values may be up to 65,535 characters, so inserting a long value would _fail_.
- **The alternative covering index was measured and rejected.** A `UNIQUE (key) INCLUDE (id)` index that skips the sort ran at 116 ms median, versus 63 ms for the planner's hash join + sort. See §6.

**Adaptive search plan (no-match and rare-match searches stay fast).** A keyset page ordered by `id` with a filter is cheap when matches are common: Postgres walks the primary key and stops after 51 hits. When a term matches nothing, the same plan walks all 50k keys. A single plan cannot be best for both, so `TranslationQueryRepository` runs two phases:

1. **Probe:** look at the next 2,000 ids after the cursor only, with per-key `EXISTS` predicates. Common terms fill the page here in about 1–3 ms.
2. **Set:** if the page is not full, run the filter the other way round, driven by the GIN (tsvector / trigram) and tag indexes. The matching key ids are collected in a `MATERIALIZED` CTE, then joined back in key order. A term with no matches costs about 0.2 ms in each phase (see the plans in §6).

Both phases share the same SQL fragments (`tag-filter.sql.ts` provides the probe and set forms of the tag predicates) and are covered by e2e tests that place matches inside and outside the probe window.

**One statement per page (no N+1).** The page of keys is selected with `LIMIT n+1` in a subquery, and each key's values and tags are aggregated with correlated `json_object_agg` / `json_agg` over that page only. The earlier version used 3 queries per page (keys, values `= ANY`, tags `= ANY`); folding them into one statement removed two round trips and raised list throughput from 531 to 720 req/s on one worker.

**Tags attach to keys, not to per-locale values.** "mobile" describes what a string is _for_, not its French wording. Tagging values would duplicate every tag per locale and allow drift between them.

**Locales are rows.** Adding a language is `POST /locales`, which is an `INSERT`. There is no enum, no column per language, no migration and no deploy.

**The aggregate root is the translation key** together with its per-locale values. Keys are immutable: a rename is a delete plus a create, which keeps frontend references and cached exports coherent.

**A versioned cache instead of TTL-only caching (export freshness).**

1. **Postgres owns the version.** Every catalog write runs through `CatalogTransaction`, which inserts a row into the append-only `catalog_changes` table _inside_ the transaction. `max(id)` is the catalog version. A rollback leaves no row, so it can never change the version; an e2e test forces a rollback with a DB trigger to prove this.
2. **Redis caches it.** After the commit, the new version is published to Redis with a set-if-greater Lua script (retried 3 times), and the publish is awaited before the HTTP response is sent. Out-of-order publishers cannot move the value backwards.
3. The export cache key is `export:{locale}:{format}:{tags}:v{version}`, and the ETag is a weak hash of that key.
4. A write therefore makes every older entry _unreachable_ without deleting anything, so there is no delete-versus-rebuild race. Old entries expire through their TTL (5 minutes by default; a superseded version is never read again).
5. **A `304` costs one Redis round trip** (a `GET` of the version) and an in-memory locale check. Postgres is not touched and the payload is not read.
6. **Cold build:** one SQL query, then the formatter (which yields to the event loop every 5,000 entries so other requests keep flowing), then gzip level 4, then a stored compressed buffer. Warm hits do no serialization or compression at all.
   - An **in-process LRU** (64 MB by default) sits in front of Redis so warm hits do not pull about 0.6 MB from Redis on every request. It needs no invalidation, because a key's content never changes.
7. **Stampede protection:** concurrent cold requests for the same key share one in-process build (`SingleFlight`). Across instances, one builder is elected with Redis `SET NX PX`; the others poll for at most `EXPORT_LOCK_WAIT_MS` (400 ms) and then build themselves, so a crashed lock holder costs one duplicate build, not a stuck request.
8. **Freshness across instances:** each instance's locale cache is keyed by the catalog version it has seen, so deactivating a locale on instance A returns a 404 from instance B's export immediately.
9. **Side effects are debounced.** CDN purges and cache warming run in the background through `latestOnly`: a burst of 100 writes produces one purge and one warm, for the newest version.
10. **Redis failure modes:**
    - **A publish that fails after a commit heals itself.** `VersionReconciler` republishes `max(id)` every 5 s (`CATALOG_RECONCILE_INTERVAL_MS`), so the export is stale for at most one interval instead of a cache TTL. An e2e test drops a publish and watches the export recover.
    - **A Redis value ahead of Postgres** (a database restore, corruption) would otherwise freeze exports, because publishing never lowers the value. The reconciler detects it and repairs it with compare-and-set, so it can never overwrite a legitimate concurrent publish. Also e2e tested.
    - If Redis loses the key, the next read restores it from Postgres, so versions stay monotonic and old ETags cannot collide with new ones.
    - If Redis is unreachable on the read path, the export degrades to an uncached build straight from Postgres, sent with `Cache-Control: no-store` and no ETag. This is correctness over speed.
    - Compose runs Redis with AOF and `volatile-lru`, so the version key, which has no TTL, is never evicted.

**Two export strategies, benchmarked** ([`docs/benchmarks/export-build.txt`](docs/benchmarks/export-build.txt), 50k entries, 3.2 MB of JSON, median of 9 runs):

| Step                                                        |       Median |
| ----------------------------------------------------------- | -----------: |
| A: SQL rows (122 ms) + JS flat render (23 ms)               |       145 ms |
| B: `json_object_agg(key, value ORDER BY key)` in Postgres   |       119 ms |
| gzip level 4, once per version (**shipped**; 596 kB, 18.5%) |        39 ms |
| gzip level 6 (565 kB, 17.5%)                                |        78 ms |
| **A total with gzip-4** / **B total with gzip-4**           | 184 / 157 ms |

Strategy A is kept even though B was ~27 ms faster in this run (earlier runs had A ahead; the two are within run-to-run noise of each other on this laptop). A feeds every formatter strategy, including `nested`, whereas B only produces the flat format; B also builds the whole document inside one Postgres backend, while A's render is cooperative and leaves Postgres free sooner. Both are far inside the 500 ms budget. Gzip level 4 halves compression time compared with level 6 for 5.7% more bytes.

**Keyset (cursor) pagination.**

- `WHERE id > $cursor ORDER BY id LIMIT n+1` costs the same on page 1 and page 1,000. OFFSET degrades linearly.
- The cursor is opaque base64url JSON (`{v, id}`), validated on decode. A tampered cursor returns a 422.
- Pagination is on `id` only. There is no user-chosen sort column, so there is nothing to inject into `ORDER BY`.

**Nested export key collisions.** If both `a.b` and `a.b.c` exist, a leaf always owns its path. The deeper key is written as a literal dotted key in the deepest object that can be reached: `{ "a": { "b": "x", "b.c": "y" } }`. The rule does not depend on input order, drops nothing, runs in O(total key length), and builds null-prototype objects, so a key like `__proto__` is harmless.

**Public versus private export (CDN).**

|                       | `EXPORT_PUBLIC=false` (default)                                                       | `EXPORT_PUBLIC=true`                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication        | `export:read` scope required                                                          | none                                                                                                                                                                                                                          |
| `Cache-Control`       | `private, no-cache` (browsers revalidate with the ETag; shared caches never store it) | `public, max-age=0, s-maxage=60, stale-while-revalidate=30, must-revalidate`                                                                                                                                                  |
| `Vary`                | `Accept-Encoding, Authorization` (merged with CORS' `Origin`)                         | `Accept-Encoding`                                                                                                                                                                                                             |
| Freshness at the edge | not cached at the edge                                                                | Bounded by `s-maxage`. Each catalog change calls the `CdnPurger` (an HTTP purge, Cloudflare/Fastly style, when `CDN_PURGE_URL` is set; a no-op `NullCdnPurger` otherwise). After a purge, the edge revalidates with the ETag. |

**The trade-off:** a public export moves almost all read traffic to the CDN. Translation strings are not secret for most products, but they become world-readable, and without a purger, edges can lag a write by up to `s-maxage` seconds. Keep the export private when strings are confidential (unreleased features) or when absolute freshness at the edge matters more than offloading traffic. `EXPORT_WARM_ON_CHANGE=true` pre-builds every active locale after each change, so the first request after a purge is already a warm hit.

---

## 6. Benchmarks (real runs, 200,000 translations)

**Environment:**

- 11th Gen Intel Core i5-1145G7 (4 cores / 8 threads, laptop), 16 GB RAM, Windows 11
- Node 24.13 (the image targets Node 22 LTS)
- PostgreSQL 16.13 (`shared_buffers=256MB`)
- Redis 5.0.14 on the same host (the Windows port; Compose uses Redis 7)
- The server ran from the compiled `dist/` with `NODE_ENV=production` and **2 cluster workers** (`APP_WORKERS=2`)
- autocannon used **50 connections for 15 s** per scenario, on the same laptop as the server, Postgres and Redis
- p50, p95 and p99 are exact, computed from per-response timings
- Reproduce with `npm run test:perf`. The raw table is in [`docs/benchmarks/autocannon.md`](docs/benchmarks/autocannon.md).

| Scenario                                                             | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Budget |  Result  |
| -------------------------------------------------------------------- | -------: | ----: | -----: | -----: | -----: | -----: | -----: | :------: |
| GET /translations (first page, 50)                                   |    11424 |   762 |     60 |    111 |    166 |    837 | 200 ms |   PASS   |
| GET /translations?key=checkout.button.                               |     7990 |   533 |     88 |    142 |    161 |    437 | 200 ms |   PASS   |
| GET /translations?q=payment (word)                                   |     6931 |   462 |    118 |    176 |    274 |    894 | 200 ms |   PASS   |
| GET /translations?q=ccoun (substring)                                |     7394 |   493 |     97 |    138 |    160 |    704 | 200 ms |   PASS   |
| GET /translations?q=zqxjkv (**no match**)                            |    15733 |  1049 |     18 |    104 |    139 |   1015 | 200 ms |   PASS   |
| GET /translations?q=%234999 (**rare match**)                         |     9051 |   603 |     89 |    126 |    154 |    496 | 200 ms |   PASS   |
| GET /translations?tags=mobile                                        |     9094 |   606 |    105 |    162 |    216 |    718 | 200 ms |   PASS   |
| GET /translations?tags=web,mobile&tagsMode=all                       |     5461 |   364 |    158 |    270 |    380 |   1259 | 200 ms | **FAIL** |
| GET /translations?locale=fr&q=paiement                               |     9224 |   615 |     78 |    121 |    157 |    849 | 200 ms |   PASS   |
| GET /locales                                                         |    29555 |  1970 |     24 |     35 |     43 |     73 | 200 ms |   PASS   |
| GET /tags                                                            |    36738 |  2450 |     19 |     27 |     37 |     66 | 200 ms |   PASS   |
| GET /translations?cursor=… (deep page)                               |    11647 |   776 |     63 |     98 |    122 |    709 | 200 ms |   PASS   |
| GET /translations/:id                                                |    27487 |  1832 |     35 |     50 |     70 |    283 | 200 ms |   PASS   |
| POST /translations                                                   |     6770 |   451 |    101 |    169 |    218 |    342 | 200 ms |   PASS   |
| PATCH /translations/:id                                              |    11145 |   743 |     20 |    152 |    194 |    920 | 200 ms |   PASS   |
| **GET /export/en cold** (cache miss after a write; n=15, sequential) |       15 |     – |    197 |    320 |    320 |    320 | 500 ms |   PASS   |
| GET /export/en warm (pre-gzipped, 0.6 MB) †                          |     3278 |   234 |    209 |    439 |    512 |    613 | 500 ms |   PASS   |
| GET /export/en?format=nested warm †                                  |     4641 |   313 |    158 |    209 |    224 |    300 | 500 ms |   PASS   |
| GET /export/en `304` (If-None-Match)                                 |    45979 |  3066 |     14 |     29 |     45 |    343 |  50 ms |   PASS   |

† 4 autocannon worker threads, because a single client thread saturates on ~0.6 MB bodies before the server does. Per-response timings are not available in worker mode, so the "p95" cell shows **p97.5**, an upper bound.

**How to read this table honestly:**

- **18 of 19 scenarios pass at 50 connections. `tagsMode=all` is borderline:** its p95 was 177 ms in the previous run and 270 ms in this one. The query itself takes 4 ms (plan below); at 50 connections the rest is queueing for 8 CPU threads shared by autocannon, two Node workers, Postgres and Redis. On separate machines, or at the 10 connections used earlier (p95 29 ms), it is well inside the budget. I report the failing run rather than the passing one.
- **Throughput here is bound by the host, not the code.** Going from 1 to 4 workers did not raise req/s on this laptop, because Postgres and the load generator compete for the same cores. 2 workers was the best setting, so it is the Compose default.
- **The max column** includes GC pauses and Windows scheduling spikes; the budgets are on p95.
- **Cold exports** are 150–230 ms in steady state. Right after a burst of writes, a cold build competes with the write load and can reach about 320 ms, still under 500 ms.
- **Warm exports** were measured with a 100 ms budget at 10 connections (p97.5 31 ms). At 50 connections each response is 0.6 MB, so the run is bandwidth- and client-bound; the budget for that row is 500 ms. In production these responses come from the CDN or the browser cache (`304`).
- **No-match search** used to scan every key (the review finding that started the adaptive plan). It is now the cheapest search scenario.

**Query plans** ([`docs/benchmarks/explain-hot-queries.txt`](docs/benchmarks/explain-hot-queries.txt)). `npm run perf:explain` calls the real repository methods, captures the exact SQL and parameters through Kysely's log hook, and runs `EXPLAIN (ANALYZE, BUFFERS)` on each statement. It fails on an unexpected seq scan, on more than 10,000 rows removed by a filter, or on any search statement over 50 ms.

| Hot path (one statement per page, values and tags included) | Plan                                                                                  |    Execution |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | -----------: |
| List page / deep keyset page                                | `Index Scan` on `translation_keys_pkey` + correlated aggregates on the unique indexes |   0.1–1.1 ms |
| Key prefix                                                  | b-tree range scan on `translation_keys_key_key` (C collation)                         |       1.5 ms |
| Word / substring content (common term)                      | probe phase: pk window + per-key `EXISTS`                                             |   1.9–2.8 ms |
| Content with **no match**                                   | probe 0.19 ms, then set phase over the GIN indexes 0.17 ms                            |       0.4 ms |
| Content with a **rare match**                               | probe 0.9 ms, then set phase (`MATERIALIZED` CTE from the trigram GIN) 9.1 ms         |      10.0 ms |
| Tags `any` / `all`                                          | `Index Only Scan` on `translation_key_tags`                                           | 1.2 / 4.0 ms |
| Prefix + tags + content                                     | probe 2.2 ms, then set phase 30 ms                                                    |        32 ms |
| Show one key                                                | pk lookup + aggregates                                                                |      0.05 ms |
| Token lookup                                                | unique index on `token_hash` (seq scan on the tiny test table)                        |      0.02 ms |
| Export (whole locale / tag `mobile`)                        | `Bitmap Index Scan on translations_locale_key_idx` + hash join + sort                 | 103 / 114 ms |

There is **no sequential scan on a large table on any hot path, with one documented exception.** A full-locale export must read every translation key, which is 100% of `translation_keys`. A seq scan of that table (about 4 ms) feeding a hash join is the cheapest plan. Forcing an index-only scan in key order to avoid the sort measured **2× slower** (116 ms versus 63 ms median). The seq scans on `locales` and `tags` in the plans are on tables of 4–5 rows, where an index would be slower.

---

## 7. Security

- **Tokens:**
  - 256-bit opaque tokens from `crypto.randomBytes(32)`, prefixed `tms_` so secret scanners recognise them. The plaintext is returned once.
  - **Only the SHA-256 is stored**, compared with `timingSafeEqual`.
  - Every token has scopes and an expiry, and can be revoked with `DELETE /auth/tokens/current`.
  - `last_used_at` is written at most once a minute per token.
  - **Verified tokens are cached in-process for 5 s** (`AUTH_TOKEN_CACHE_MS`, set `0` to disable), which removes a database lookup from almost every request. The trade-off: revoking a token takes effect immediately on the instance that handled the revoke, and within 5 s on the others. Expiry is still checked on every cached hit.
- **Passwords:**
  - argon2id with the OWASP baseline (19 MiB, t=2, p=1).
  - Unknown emails still run a dummy verification, so response timing does not reveal which accounts exist.
  - Passwords are capped at 1,024 characters to prevent argon2 CPU abuse.
  - The admin user is provisioned **only** from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; nothing is hard-coded.
- **Secure by default:**
  - The global guard order is auth throttle → bearer → scopes → api/export throttle. Routes opt _out_ with `@Public()`. The export uses `@Public(config => config.export.public)`.
  - A user can only mint tokens whose scopes are a subset of that user's own scopes.
- **Rate limits** (Redis-backed, atomic Lua script, shared across instances):
  - `/auth/tokens`: 5/min per IP + email
  - the API: 120/min per token, or per IP when anonymous
  - the export: its own budget of 600/min
  - **invalid bearer tokens: 30/min per IP** (`THROTTLE_AUTH_FAILURE_LIMIT`), checked _before_ the token lookup. Without it, an attacker could send a fresh random token on every request, and each one would get its own budget.
  - The api and export throttles run _after_ authentication and are keyed by the verified token id, so budgets cannot be minted by inventing tokens.
  - Throttled requests get a 429 with a standard `Retry-After` header.
- **Input:**
  - Global `ValidationPipe` with whitelisting and `forbidNonWhitelisted`, which makes unknown fields a 422 (no mass assignment).
  - Request bodies are JSON only (any other type is a 415) and limited to 1 MiB (413). Fastify's secure parser rejects prototype poisoning.
  - `values` keys are checked against active locales. Ids and locale codes are validated by pipes.
- **SQL:** all queries are parameterized. There is no `sql.raw` with user input. LIKE metacharacters are escaped, and there is no leading wildcard on keys. There is no user-chosen `ORDER BY`. CHECK constraints in the database back up the DTO validation.
- **Output:**
  - One global filter emits generic RFC 7807 bodies. Postgres errors are mapped by SQLSTATE only (`23505` and `23503` → 409).
  - 500s are logged in full with the `requestId` but never echoed.
  - Response DTOs are explicit classes; raw rows are never returned.
- **Transport and headers:**
  - helmet: CSP, HSTS, `nosniff`, frame options.
  - CORS is restricted to `CORS_ORIGINS`.
  - The request id is taken from `X-Request-Id` only if it is a valid ULID or UUID; otherwise a new one is generated. It is echoed back and bound to the logs.
- **Logging:** pino output is structured JSON with `authorization`, `cookie`, `password` and `token` redacted wherever they appear. A unit test covers the redaction.
- **Operations:**
  - The container runs as the non-root `node` user, with a read-only root filesystem, `cap_drop: ALL` and `no-new-privileges`.
  - `.env.example` contains no secrets.
  - CI runs `npm audit --omit=dev`.
  - Configuration is validated at startup and the app fails fast. Graceful shutdown closes the database and Redis pools and drains background work.
- **No CRUD generators or i18n packages:** the dependency list contains neither CRUD generators (`@nestjsx/crud` and similar) nor translation packages (`nestjs-i18n`, `i18next` and similar).

---

## 8. Configuration

Every variable is validated at startup by [`src/config/app-config.ts`](src/config/app-config.ts), and an invalid value stops the process with a list of every problem. [`.env.example`](.env.example) documents them all. The most important:

| Variable                                                               | Default                  | Purpose                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`                                            | required                 | Connection strings                                                                                                          |
| `DB_POOL_MAX`                                                          | 20                       | Size of the pg pool. Every connection also gets `statement_timeout` (5 s) and `idle_in_transaction_session_timeout` (10 s). |
| `EXPORT_PUBLIC`                                                        | false                    | CDN mode (see §5)                                                                                                           |
| `APP_WORKERS`                                                          | 1 (Compose: 2)           | `node:cluster` workers; crashed workers are restarted                                                                       |
| `SWAGGER_ENABLED`                                                      | on, off in production    | Serve Swagger UI at `/docs`                                                                                                 |
| `EXPORT_CACHE_TTL_SECONDS`                                             | 300                      | Lifetime of a cached export version in Redis (superseded versions are never read again)                                     |
| `CATALOG_RECONCILE_INTERVAL_MS`                                        | 5000                     | How often Postgres' version is republished to Redis; the upper bound on staleness after a failed publish                    |
| `EXPORT_LOCK_WAIT_MS` / `EXPORT_SIDE_EFFECT_DEBOUNCE_MS`               | 400 / 250                | Wait for another instance's build; debounce for purge and warm                                                              |
| `AUTH_TOKEN_CACHE_MS`                                                  | 5000                     | Verified-token cache lifetime (0 disables it)                                                                               |
| `THROTTLE_AUTH_FAILURE_LIMIT`                                          | 30 per minute            | Invalid bearer tokens per IP before 429                                                                                     |
| `EXPORT_MEMORY_CACHE_MB`                                               | 64                       | Per-instance in-process LRU in front of Redis                                                                               |
| `EXPORT_WARM_ON_CHANGE`                                                | false                    | Pre-build active locales after each change                                                                                  |
| `CDN_PURGE_URL` / `CDN_PURGE_TOKEN` / `CDN_PUBLIC_BASE_URL`            | unset                    | HTTP purge hook                                                                                                             |
| `THROTTLE_AUTH_LIMIT` / `THROTTLE_API_LIMIT` / `THROTTLE_EXPORT_LIMIT` | 5 / 120 / 600 per minute | Rate limits                                                                                                                 |
| `AUTH_TOKEN_DEFAULT_TTL_SECONDS` / `AUTH_TOKEN_MAX_TTL_SECONDS`        | 1 day / 30 days          | Token lifetime                                                                                                              |
| `CORS_ORIGINS`                                                         | none                     | Comma-separated allowlist                                                                                                   |

---