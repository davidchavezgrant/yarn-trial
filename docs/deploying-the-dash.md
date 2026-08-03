# Hosting the dash — sharing benchmark results

Verified 2026-08-03 against the 2026-08-01 pass (198 entries, 195 collected, 43 filmed takes).

The dash is a reader that normally sits beside the store it reads. Hosting it means separating
the two, and the whole trick is that the separation is cheap: what the board *renders* is
~6 MB of JSON and text (plus the filmed runs' cursor renders — see below), while what the store
*holds* is 1.4 GB of step frames, raw captures and trajectories.

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

**`/api/video?job=<id>`** is the one binary route: a filmed run's cursor render, streamed with
range support (206/416) so the player can seek. It needs no share-mode special case, because it
serves whatever the snapshot carried and the snapshot carries only renders. Two properties worth
knowing: it is **local-file only** — no ssh tier, unlike `/api/logs`, so "no video here" means
"not collected yet" — and it sits behind the same `DASH_AUTH` gate as everything but `/healthz`.
The board carries a first-level **Take** column, beside Map and Graphs. It reads per RUN (like
Map, unlike the per-arm Graphs page), and the ▶ appears only where the state frame said a render
exists — `EntryView.video`, resolved by the same `hasTake` the route serves through, so a row
never advertises a video the server cannot serve. Every other run shows an explicit `–`.

Verified end to end on 2026-08-03, against both a local share-mode dash and the pushed image:
200 with `accept-ranges`, correct 206 for head/tail/suffix ranges, 416 past EOF, 400 on a
traversal-shaped id, 404 for an unfilmed run, 401 unauthenticated, and the player decoding a
45.65 s 1568×960 take. The board's own check: folded on load with the Take header present,
"expand all" revealing 183 run lines and 43 ▶, and playback surviving three forced re-renders
(the player lives in a modal in the static page precisely so it can).

**Posture note.** A frozen render is evidence, not a live capability — the same class as the run
log text this dash already serves, and nothing like `/peek`, which reaches into a colo Mac. But it
is video of Yarn's product UI on a public URL behind Basic auth, which is a deliberate choice
rather than an implied one.

**Frozen states.** The shipped 2026-08-01 manifest holds 173 done, 22 failed and **3 still
mid-run** (nothing queued — the pass drained). A live dash resolves those against the fleet; a
snapshot has no fleet to ask, so without help it would claim three runs are executing forever. `freezeStates` retires them to `abandoned` and
`never-ran` — display only, and `rollup()` reads neither, so no figure moves.

**`/healthz`** is the one unauthenticated route: 200, the word `ok`, nothing else. A PaaS health
check cannot send credentials, so without it a dash behind `DASH_AUTH` fails its own check and
gets restarted forever.

## The snapshot

`./run dash:snapshot` is a pure reader over `out/bench`; it writes only under `--dest`.

| | |
|---|---|
| output | `<dest>/out/bench/live/…` — the same layout the dash already reads, so no snapshot awareness is needed anywhere |
| size | **90.4 MB**, 1145 files, 195 of 198 run dirs, 43 cursor renders (3 entries never wrote a dir). Measured 2026-08-03 at the shipped snapshot; it was 6.0 MB before the renders travelled |
| carries | manifest, per-run `run.json` / `events.jsonl` / `journal.jsonl` / `log.txt` / `appmap.*` / `checkpoint.json`, the per-arm appmap archive, the pass report, `narrative.jsonl`, and each filmed run's `recording/humanized.mp4` |
| drops | `steps/`, and the rest of `recording/` — frames, `trajectory/`, and the raw cursorless `window.mp4`. ~36 MB per run of *evidence*; the board charts its *metrics* and shows the one artifact that is itself a result |

**The takes.** A filmed arm's deliverable is footage, so the cursor render travels: ~1.3 MB per
run against the ~36 MB directory it sits in, because `frames/` and `trajectory/` are the render's
*input* and stay behind. The raw `window.mp4` stays behind too — it is the same take with no
cursor in it (the fleet's capture draws none; `humanize` composites one from the run's own click
points and typing timings), so shipping both would double the bytes to show a strictly worse
video.

Coverage is a property of the pass, not of the dash. The 2026-08-01 pass shipped 2026-08-03 with
198 entries, 195 collected, **48 filmed arms and 43 renders** — 43 of 198 rows offer a ▶, a bit
over a fifth. Two caps, neither fixable here:

- **Explores are deliberately never filmed.** `--record` swaps in demo rules and a demo act tool
  with no `set_value`, which changes what the pass DOES — a filmed explore would produce a
  different map from the one every downstream arm is grounded on (`matrix.ts`'s `filmed`). Every
  grounding-pass row therefore shows `–`, and those are the rows a folded board shows first.
- **5 filmed entries have no render**: 3 left no run directory (evicted, or never wrote one) and
  2 hold frames whose trajectory has no driver turns — `humanize` exits with "nothing to animate",
  which is an honest answer rather than a failure to retry.

**Collect before snapshotting.** `bench collect` composites on pull (`humanizePulled`, `HUMANIZE=0`
disables), so the render count climbs as runs land: this pass went 20 → 28 → 33 → 43 over the
half-hour a collect was draining it. A snapshot taken mid-drain is honest but stale, and
redeploying is one `render deploys create --image`.

Renders outside the published manifest appear on no board — a `2026-08-02T18-51-*` batch of 13 at
last count. The dash renders manifest entries, and those runs belong to no pass's manifest.

**Image size is now the thing to watch: 584 MB**, of which ~95 MB is the snapshot and ~87 MB of
that is video. One more filmed pass of this size doubles the video and the argument for moving
renders to `assets.yarn.so` (already on CloudFront) with the board linking out becomes the
cheaper option — see the pre-rendering note under Choosing.

`snapshots/` is gitignored: it is a regenerable duplicate of manifests already tracked under
`out/bench`, plus 800-odd run logs. Build the image locally and push it (below) and the bytes
never travel through git.

## Deploying

`Dockerfile.dash` is platform-neutral — it binds `$PORT`, listens on `0.0.0.0`, runs as `node`,
and carries the snapshot at `/app/snapshot`. Built and run end-to-end on 2026-08-03: **584 MB**
with the takes (444 MB before them), all routes verified, page renders.

```bash
./run dash:snapshot --date 2026-08-01 --dest snapshots/current
docker build -f Dockerfile.dash -t yarn-dash:2026-08-01 .
docker run --rm -p 8080:10000 -e PORT=10000 -e DASH_AUTH='user:pass' yarn-dash:2026-08-01
```

**`docker: command not found` on this machine, with Docker Desktop running.** The app lives at
`/Applications/Development/Docker.app`, not `/Applications/Docker.app`, and the installer's 2022
symlink at `/usr/local/bin/docker` still points at the old path — so it dangles while the daemon
and its socket (`~/.docker/run/docker.sock`) are perfectly healthy. The CLI *and* the credential
helper it shells (`docker-credential-desktop`, without which any build that touches a registry
fails with `error getting credentials`) both sit in the app bundle:

```bash
export PATH="/Applications/Development/Docker.app/Contents/Resources/bin:$PATH"
```

Worth fixing permanently by repointing the symlink or adding that line to the shell profile;
diagnosed 2026-08-03, Docker 28.3.0 client and server.

### Render — DEPLOYED 2026-08-03

Live in the **Yarn** workspace (`tea-c9b5apvho1kjc8a5l9t0`), from a private image:

| | |
|---|---|
| URL | <https://yarn-bench-dash.onrender.com> (Basic auth) |
| service | `srv-d9o382u7bikc73csivm0` · starter · oregon · `autoDeploy: no` |
| image | `ghcr.io/davidchavezgrant/yarn-bench-dash:2026-08-03b` (**private** package) — 584 MB. Earlier tags stay pullable, so a rollback is one `render deploys create --image` |
| registry credential | `rgc-d9o36ptaeets73cvdgl0` (`ghcr-davidchavezgrant`) |
| health check | `/healthz` |

Why an image and not build-from-repo: `davidchavezgrant/yarn-trial` **is a public GitHub repo**
(verified `"private": false`, 2026-08-03 — earlier notes calling it private are stale). A
build-from-repo needs `git add -f snapshots/current`, which would publish 852 run logs, per-run
costs and appmaps of Yarn's app to a public repo. The image path keeps all of it out of git.

`render.yaml` remains committed for the build-from-repo route, should the repo ever go private.

**The CLI cannot create services, but it CAN redeploy a new image** — which is the whole
redeploy loop, so no REST API key is needed for the routine case (corrected 2026-08-03; the note
below used to imply otherwise). `render services` is list-only, so the *first* creation still
needs a key (Dashboard → Account Settings → API Keys): `POST /v1/registrycredentials`, then
`POST /v1/services` with `image.imagePath` + `registryCredentialId` and
`serviceDetails.env: "image"`. After that, `render deploys create` takes `--image`:

```bash
render deploys create srv-d9o382u7bikc73csivm0 \
  --image ghcr.io/davidchavezgrant/yarn-bench-dash:<tag> --wait --confirm
```

That is what makes a new dated tag preferable to overwriting an old one: the previous image stays
reachable by tag, so a rollback is one more `deploys create` rather than a rebuild.

**Build for linux/amd64 or Render rejects the image.** Every Mac here is Apple Silicon, so an
unpinned build produces arm64 and `POST /v1/services` fails with *"points to an image with an
invalid platform"*. `Dockerfile.dash` pins `--platform=linux/amd64` on both stages, and a
cross-build needs buildx, not the classic builder:

```bash
docker buildx build --platform linux/amd64 -f Dockerfile.dash \
  -t ghcr.io/davidchavezgrant/yarn-bench-dash:<date> --push .
```

Pushing to ghcr needs `write:packages` on the gh token
(`gh auth refresh -h github.com -s write:packages,read:packages`), then
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

**Redeploying a new pass:** snapshot → buildx build/push under a new tag → `PATCH
/v1/services/srv-d9o382u7bikc73csivm0` with the new `imagePath` → `POST …/deploys`. `autoDeploy`
is off deliberately: the image is data, and data should not redeploy because a registry tag moved.

#### Hygiene debt on this deployment

The registry credential holds a **broadly-scoped personal token** — the same `gh` OAuth token
that carries `repo`, `workflow`, `gist` and `write:packages`, stored in the *company's* Render
workspace where other members can use it to pull. Replace it with a fine-grained PAT scoped to
`read:packages` on that one package, and note that `gho_` tokens expire, which would break image
pulls at some later date with a confusing "unauthorized" on deploy.

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
