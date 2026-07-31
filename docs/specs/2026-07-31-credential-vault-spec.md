# Credential vault — spec

*2026-07-31, branch `worktree-credential-vault`. The feature that lets a run land on any free Mac
and still be the right operator inside the target app. Threat model:
`docs/research/2026-07-31-credential-vault-threat-model.md`.*

## Problem

The remote rendering fleet must route the same operator to the same box every run, because the
signed-in session lives only on the box they signed in on. That is a scheduling constraint (a busy
"right" box blocks a run while other boxes sit idle) and a scaling wall.

## Approach — one sentence

Boxes are stateless; the session is a **leased, probe-verified, encrypted artifact** the vault
moves to whichever box the run picks; portability is **measured per app**, not assumed; and every
failure mode degrades to "one human sign-in on the box the job landed on" — never wrong routing.

The design *requires* only "a human can sign in on any box once" (already true via `signin`/
liveview). Portability is an optimization layered on top that reduces sign-in count from N×boxes
toward N. When it fails for an app, the system **notices and degrades** instead of breaking.

## Architecture

Everything recomposes existing parts; the genuinely new artifact is the ledger.

```
operator's laptop                         colo Mac (runner)
─────────────────                         ─────────────────
creds.ts (orchestration)   ── ssh ────►   runnerctl credexport / credimport
credstore.ts (vault):                     credbundle.ts  → profiles.installProfile
  bundles/  (AES-GCM tars)                 profiles.ts store (parked/live)
  ledger.json                ◄─ rsync ─    out/credstage/*.tar.gz  (plaintext, transient)
  audit.jsonl
```

- **Bytes ride rsync, control rides the socket.** The runnerctl socket caps a request at 1 MB, so
  session tarballs move as whole files over the existing pinned rsync channel — exactly the split
  `dispatch.pull` already makes for artifacts.
- **A bundle IS a portable `profileDir`**: home-relative paths + `manifest.json`, the same on-disk
  shape the profile store uses, so import hands the unpacked directory straight to
  `installProfile` with no translation.

## Components (all in `src/remote/`)

| File | Role | Tests |
|---|---|---|
| `control/credstore.ts` | Vault: seal/open (AES-GCM), bundle put/get, ledger, audit | `credstore.test.ts` |
| `control/creds.ts` | Orchestration: checkout / checkin / recordRunOutcome / signout-everywhere + CLI | `creds.test.ts` |
| `runner/credbundle.ts` | Export (snapshot session → tar) / import (tar → live session) | `credbundle.test.ts` |
| `runner/tarball.ts` | `tar` wrapper (execFile, no shell) | `tarball.test.ts` |
| `runner/profiles.ts` | `installProfile` (force-restore-from-parked) + `currentOwner`/`ownsLive` | `profiles.test.ts` |
| `keychain.ts` + `keychain-cli.ts` | macOS Safe Storage equalization for Electron targets | `keychain.test.ts` |
| `backends/cdp.ts` | `--use-mock-keychain` → portable web profiles | (flag) |

## Ledger schema (`credstore.LedgerEntry`, keyed by `<operator>/<slug>`)

```ts
{
  operator, slug, app,
  portability: "unknown" | "roams" | "bound",   // LEARNED, never assumed
  lastHost?: string,                             // where checkout pulls from
  sha256?: string,                               // integrity of the freshest bundle
  holders: { [host]: { verifiedAt, signedIn } }, // per-box probe state
  updatedAt,
}
```

`portability` is the whole design in miniature: an app's session-roaming behavior is a fact the
fleet observes and records, so an external change (Google enabling DBSC) flips a field, not the
architecture.

## Dispatch decision table (on by default; `YARN_VAULT=0` disables)

| Situation | Action |
|---|---|
| Same (operator, app) already live on another box | **Refuse** the dispatch (single writer per session) |
| Target already owns operator's session (`skipped-owned`) | Leave local session; probe decides (may be fresher than vault) |
| Vault has a bundle, target doesn't own it | Push + `installProfile` (parks any other operator first) |
| Vault has no bundle (`no-bundle`) | Nothing pushed; run signs in for the first time |
| Run got past readiness (exit ≠ 3) | **Checkin**: seal current session into vault, `lastHost = target` |
| Run refused on readiness (exit 3) | **No checkin** (don't overwrite a good bundle with a dead one); mark `bound` if it was a moved bundle |
| Moved bundle signed in / failed | Ledger learns `roams` / `bound` |

On by default (opted in 2026-07-31). `YARN_VAULT=0` reverts dispatch to leaving each box's local
session in place — the kill switch if the vault ever misbehaves on a real run. The integration is
best-effort: a checkout/checkin failure logs a note and the run signs in and verifies itself, so
enabling it can only ADD a session install, never fail a run that would otherwise have worked.
`./run creds checkout|checkin` are the manual handles and work regardless.

## CLI

```
./run creds status                     what the vault holds, per operator + app + portability
./run creds audit [n]                  the last n credential events
./run creds checkout <mac> "<App>"     push the stored session onto a box
./run creds checkin  <mac> "<App>"     pull a box's current session into the vault
./run creds signout-everywhere "<App>" wipe this operator's session across the whole fleet + vault
./run keychain <check|export|seed> "<App>"   (run ON a box) Safe Storage equalization for Electron
```

## Verification status (this repo's convention)

- **Unit + typecheck:** all of the above. 1,227 tests pass; new suites cover crypto round trip,
  key discipline, ledger transitions, portability learning, the cross-operator export guard, the
  install round trip, and the orchestration with faked ssh/rsync.
- **Live-validated:** none yet — no fleet in the build environment. The paths that need a live pass
  before being declared working: a real checkout→run→checkin across two Macs; the readiness-probe
  fallback to liveview on a `bound` app; keychain equalization against a signed-in Electron app;
  and confirmation that the target apps' sessions actually roam (start with the Yarn app).

## Deliberate non-goals

- Egress-IP sharing is a colo configuration item, documented in the threat model, not built as a
  flaky network probe.
- Automated fleet-wide keychain seeding (secret-crossing automation) is left as the manual
  `keychain` CLI until it can be live-validated.
- Central off-laptop vault (S3) is the scale-up path; the store root is swappable, but O(1) central
  storage is not built — the per-laptop vault is correct for the current three-Mac fleet.
