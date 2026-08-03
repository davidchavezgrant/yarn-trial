# Hosting the dash — sharing benchmark results

Verified 2026-08-03 against the 2026-08-01 pass (187 entries, 151 collected, $220.04).

The dash is a reader that normally sits beside the store it reads. Hosting it means separating
the two, and the whole trick is that the separation is cheap: what the board *renders* is
~6 MB of JSON and text, while what the store *holds* is 1.4 GB of step frames and recordings.

Two commands. The first freezes a pass, the second serves it:

```bash
./run dash:snapshot --date 2026-08-01 --dest snapshots/current
YARN_RUNNER_DATA=snapshots/current DASH_AUTH=user:pass ./run dash --share
```

## What share mode changes

`--share` (or `DASH_SHARE=1`) is the posture for a dash strangers can reach. It is not a
separate server — the same code, the same `buildState`, so a hosted board cannot disagree with
the local one or with the report over the same manifest.

| | local dash | `--share` |
|---|---|---|
| fleet poll (ssh ×3 every 5s) | on | **off** |
| `/peek` screen streaming | on | **rejected** |
| `/api/logs` remote tier | ssh fallback | local files only |
| detail checkpoint fetch | ssh on demand | local only |
| narrator | mints notes | **off** (snapshot's notes still render) |
| `DASH_AUTH` | optional | **required — refuses to start without it** |
| `--collect` | opt-in | **refused** |

The ssh-shelling branches all gate on the host inventory, so share mode simply withholds it —
one cause, not five separate switches. See `DashOptions.share` in `src/bench/dash.ts`.

**Frozen states.** The 2026-08-01 manifest froze with 3 entries mid-run and 33 still queued. A
live dash resolves those against the fleet; a snapshot has no fleet to ask, so without help it
would claim three runs are executing forever. `freezeStates` retires them to `abandoned` and
`never-ran` — display only, and `rollup()` reads neither, so no figure moves.

**`/healthz`** is the one unauthenticated route: 200, the word `ok`, nothing else. A PaaS health
check cannot send credentials, so without it a dash behind `DASH_AUTH` fails its own check and
gets restarted forever.

## The snapshot

`./run dash:snapshot` is a pure reader over `out/bench`; it writes only under `--dest`.

| | |
|---|---|
| output | `<dest>/out/bench/live/…` — the same layout the dash already reads, so no snapshot awareness is needed anywhere |
| size | **6.0 MB**, 852 files, 153 of 187 run dirs (34 entries never wrote one — queued, or evicted by collect) |
| carries | manifest, per-run `run.json` / `events.jsonl` / `journal.jsonl` / `log.txt` / `appmap.*` / `checkpoint.json`, the per-arm appmap archive, the pass report, `narrative.jsonl` |
| drops | `steps/` and `recording/` — ~36 MB per run of frames and mp4s, the run's *evidence*; the board charts its *metrics* |

`snapshots/` is gitignored: it is a regenerable duplicate of manifests already tracked under
`out/bench`, plus 800-odd run logs. Build the image locally and push it (below) and the bytes
never travel through git.

## Deploying

`Dockerfile.dash` is platform-neutral — it binds `$PORT`, listens on `0.0.0.0`, runs as `node`,
and carries the snapshot at `/app/snapshot`. Built and run end-to-end on 2026-08-03: 444 MB,
all routes verified, page renders.

```bash
./run dash:snapshot --date 2026-08-01 --dest snapshots/current
docker build -f Dockerfile.dash -t yarn-dash:2026-08-01 .
docker run --rm -p 8080:10000 -e PORT=10000 -e DASH_AUTH='user:pass' yarn-dash:2026-08-01
```

### Render

`render.yaml` is committed as a Blueprint. Apply via Blueprints → New Blueprint Instance, or
drive the REST API with a `RENDER_API_KEY`. Two notes: `DASH_AUTH` is `sync: false`, so Render
prompts and stores it as a secret — never commit the value; and a build-from-repo needs the
snapshot in git (`git add -f snapshots/current`), which is the argument for pushing a prebuilt
image instead.

### Google Cloud Run — the least work per deploy

Scale-to-zero, HTTPS and a URL included, no cluster:

```bash
gcloud run deploy yarn-bench-dash \
  --source . --dockerfile Dockerfile.dash \
  --region us-central1 --allow-unauthenticated \
  --set-secrets DASH_AUTH=yarn-dash-auth:latest
```

`--allow-unauthenticated` hands access control to `DASH_AUTH` (a browser cannot satisfy Google's
IAM check). To use IAM instead, drop that flag, grant `roles/run.invoker`, and viewers reach it
through `gcloud run services proxy` — stronger, but it stops being a link you can just send.

### AWS — where Yarn's infrastructure already lives

Per `aws-running-resources.md`, account `891377169327` already runs CloudFront (incl.
`assets.yarn.so`), two ALBs, ECS and Beanstalk. **Terminology warning:** the `render.yarndist.com`
and `render.yarnorchestrator.com` distributions are Yarn's video *rendering* service and have
nothing to do with Render.com — worth disambiguating with the team.

Push to ECR and run on Fargate behind the existing ALB:

```bash
aws ecr create-repository --repository-name yarn-bench-dash
docker tag yarn-dash:2026-08-01 891377169327.dkr.ecr.us-east-1.amazonaws.com/yarn-bench-dash:2026-08-01
docker push 891377169327.dkr.ecr.us-east-1.amazonaws.com/yarn-bench-dash:2026-08-01
```

Put `DASH_AUTH` in Secrets Manager and reference it from the task definition's `secrets` block —
never `environment`. Target-group health check → `/healthz`.

## Choosing

- **Cloud Run** — least operational surface, scales to zero, one command. Best if this is a link
  you send and forget.
- **Render** — the config is already committed and it is the least new infrastructure to reason
  about.
- **ECS/Fargate** — right if the team's rule is that everything lives in the AWS account.

A fourth shape exists and is worth knowing about: in share mode the dash is *nearly static*.
Every route over a frozen snapshot is deterministic, and the SSE stream only matters when data
changes. Pre-rendering `/api/state` and one detail JSON per job onto S3 + CloudFront would drop
the server entirely — cheapest to operate, and it is where `assets.yarn.so` already lives. It
needs a static exporter plus page changes, because the page fetches query-string routes
(`/api/detail?job=…`) that do not map to S3 keys. Worth doing if this becomes a permanent
artifact; not worth it for a link shared this week.

## Image size

444 MB, and most of it is not the dash. `--omit=dev` already drops Electron, tsx and
typescript, but three runtime packages remain because `dash.ts`'s **static** import graph
reaches them:

```
@anthropic-ai/sdk   dash.ts → core/journal.ts → core/harness.ts (barrel) → harness/observation.ts
@trycua/cua-driver  …same chain → core/driver.ts
playwright-core     dash.ts → bench/graphs.ts → cursor/track.ts → agent/recording.ts → backends/cdp.ts
```

Share mode never calls into any of them. `dash.ts`'s header says it imports narrow modules and
never the harness barrel, and that is true of its *direct* imports only — `core/journal.ts`
imports the barrel outright. Severing these would cut the image by most of its bulk and remove a
native binary from a read-only board, but it is a real refactor across `journal.ts` and the
`graphs.ts → cursor` chain, not a deploy task.

Measure this with a transitive trace, never by reading imports — reading them is how the
"no npm dependencies" conclusion was reached and it was wrong. Moving `archiveDirFor` out of
`collect.ts` (2026-08-03) removed one of these paths; two remain.
