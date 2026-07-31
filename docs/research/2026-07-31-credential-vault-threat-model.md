# Credential vault — threat model

*2026-07-31. The vault is ON by default as of this date (`YARN_VAULT=0` disables it). Read this
before discussing the design with Jasper or widening the fleet. The spec is
`docs/specs/2026-07-31-credential-vault-spec.md`; this is the one page that says what the vault
**enforces** versus what it merely **audits**.*

## What the vault is for

Remove the sticky-routing constraint: today a run must be sent to the same Mac the operator signed
in on, because the session lives only there. The vault holds each operator's signed-in session for
each app as a movable, encrypted artifact, so a run can land on **any** free box and still be that
operator. Sessions move between boxes through the operator's laptop; the vault seals them at rest.

## The trust boundary — state it, don't discover it

**The boundary is "who can reach the fleet."** Everything inside it is trust plus auditing, not
cryptographic isolation. Concretely:

- The three colo Macs share one console account (load-bearing for TCC / screen capture — see
  `runner/profiles.ts`). So at the OS level every operator is the same user. The profile store and
  the vault give operators **separation**, not **security**: anyone with ssh access to a box could
  read a colleague's parked session. The audit log makes misuse visible; nothing makes it
  impossible. This is the same trust model as a shared cloud account, and it is fine for a small
  trusted team operating machines they own — **as long as it is stated.**
- A live session must exist in plaintext on whichever box is running the job (the app reads its own
  cookie jar). Compromise of a colo Mac yields whatever sessions are live or parked there.
  Compromise of the **control laptop** yields the vault, its key, and the pinned ssh keys to every
  box. That concentration existed before this feature; the vault adds a copy of the sessions to the
  laptop, which is why the laptop's disk encryption and the vault's at-rest encryption both matter.

This is **not** a multi-tenant secrets platform and must not be presented as one. It is a
well-audited team credential cache.

## Enforced vs. audited

| Property | Status | Mechanism |
|---|---|---|
| Sessions encrypted at rest | **Enforced** | AES-256-GCM per bundle (`credstore.sealBytes`); key `YARN_VAULT_KEY` or 0600 file under the 0700 runner dir |
| Passwords never stored | **Enforced by construction** | Humans type into real apps via `signin`/liveview; the vault only ever holds the resulting SESSION |
| Model never sees credentials | **Enforced** | Sessions never enter observations/prompts; run logs and demo videos are not credential channels |
| Transport authenticated + pinned | **Enforced** | Bundles ride the existing host-key-pinned, key-authed ssh/rsync channel; base64-spec discipline unchanged |
| One writer per session | **Enforced** | `runningElsewhere` refuses a dispatch when the same (operator, app) is live on another box; single-use refresh tokens can't diverge |
| No cross-operator bundle leak | **Enforced + tested** | `exportProfile` tars a session only when the requester owns it (`credbundle.test.ts`) |
| Session bytes on the wire | **In the clear only in transit** | Plaintext tar inside the ssh channel + transiently on disk at each end; sealed at rest |
| Who held which session where | **Audited** | Append-only `audit.jsonl`: checkin / checkout / probe / forget / keyseed, timestamped |
| Operator-to-operator isolation | **Audited, not enforced** | Shared console account; ssh access = read access to parked bundles |
| Revocation | **Total for OUR copies; provider-side is manual** | `signout-everywhere` wipes every box + the vault; the provider session must be revoked at its own device page |

## Deliberate weakenings, owned

1. **`--use-mock-keychain`** on the fleet Chrome replaces Chromium's per-machine cookie-encryption
   key with a fixed one, making web profiles portable. This removes a per-box speed bump;
   macOS's keychain was thin protection here anyway (the key lives in the same account as the
   data). Compensated by vault-level encryption + FileVault. **Defensible on machines you own;
   would NOT be defensible on customer machines** — say so to Jasper.
2. **Keychain equalization** (Electron targets) shares one Safe Storage key across boxes. Same
   trade, same compensation. The seed briefly exposes the key to `ps` (`security -w`), and the app
   prompts the console user once on first launch. Unverified live (macOS-only, needs two Macs).

## What breaks it, and how far

Every external actor who could break session portability only moves an app from `roams` to `bound`
in the ledger — costing sign-ins, never correctness:

- **Device-bound sessions (DBSC / hardware-attested cookies).** The IdP session (Google) is
  rarely the moved artifact — the app's own relying-party session is. If an app device-binds its
  OWN session, a moved bundle fails its readiness probe on the new box → ledger marks `bound` →
  future runs sign in on the landing box. Degrades to one human sign-in per box, not sticky routing.
- **Egress-IP heuristics.** If the boxes don't share an egress, some IdPs step-up-auth on IP
  change. Sticky *egress* (one proxy) is far cheaper than sticky *boxes*. This is a colo
  configuration item, not code — it is intentionally not built; verify it holds for the target apps.
- **Stale vault (detached laptop skipped a checkin).** A later checkout pushes a slightly-stale
  session; the readiness probe catches it and falls back to sign-in on the landing box, whose fresh
  state is then checked in. Never wrong behavior — one extra sign-in at worst.

## Revocation runbook (store or laptop compromised)

1. `./run creds signout-everywhere "<App>"` for each affected app — wipes every box's live/parked
   copy and the vault bundle + ledger row.
2. **Then** revoke the session on each provider's own device-sessions page. `signout-everywhere`
   destroys OUR copies; a bundle exfiltrated before the wipe keeps working until the provider
   expires or revokes it. The kill switch lives with the provider, not with us.
3. Read `audit.jsonl` to know which sessions existed and therefore which to rotate.
4. Rotate the vault key (delete `vault.key`, re-sign-in) and the fleet ssh identity if the laptop
   was the compromise.

## The single best property

Session bundles are self-expiring; passwords are not. This architecture caches **derived**
credentials and refuses to touch **root** credentials, so the blast radius has a built-in
half-life. That property is inherited from `signin.ts`, not added here — and it is what makes the
whole posture defensible.

## Cheap hardening still open (not blocking)

- Put `vault.key` in the laptop keychain / a YubiKey (`YARN_VAULT_KEY`) so store-at-rest encryption
  survives file exfiltration.
- Confirm the liveview WS bridge only ever listens on localhost/tunnels.
- Keep the store out of Time Machine / iCloud backup scope (backups are the classic quiet leak).
