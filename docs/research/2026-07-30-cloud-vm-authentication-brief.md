# Cloud VMs for the self-driving agent: the authentication problem

Deep-dive brief. Written 2026-07-30. Author: David Chavez Grant.

**Question (David).** Can we run this agent in cloud VMs with a *seamless* experience? The
biggest blocker is authenticating into third-party apps. So far the only thing we've tried is
opening a screen-sharing window on the customer's machine, which isn't tenable. Investigate
alternatives — including capturing an auth token/session on the client's machine and shipping
it to a remote machine so no interaction is needed — and find the most seamless path.

**One-line answer.** A *fully* seamless, zero-interaction cloud run is not achievable in 2026
for the general case, and the reason is structural, not an engineering gap we can out-build:
the industry is actively hardening browser sessions *against* being moved off the device that
created them (Google's DBSC shipped to GA in April 2026), and the one factor that is
un-delegable by design — passkeys/WebAuthn — is the direction every serious IdP is moving. But
"seamless enough" is very achievable, and the whole cloud-agent industry has converged on the
same three-layer answer. This brief lays out that answer, scores each option against *our*
constraints, and gives a concrete recommendation.

> This brief revisits, does not overturn, the conclusion in
> `2026-07-30-cua-learnings-for-real-implementation.md` §2: *"ephemeral environments are
> currently unrealistic because of authentication… sessions are the scarce resource; machines
> exist to hold them… the leverage point is auth… not virtualization."* That doc named
> "session-transfer tooling" as future leverage and left it unbuilt. This is the feasibility
> study for that line. **The verdict holds, but with a sharper edge: session transfer is not
> merely unbuilt, it is being actively defeated at the platform layer — so the cloud path runs
> through delegated/native-to-cloud login, not through transplanting the user's cookies.**

---

## 0. Frame the problem precisely — two things called "auth" that are not the same

Almost every wrong turn here comes from conflating two artifacts. Getting this straight up
front is what makes the rest of the analysis fall out cleanly.

- **API access** — an OAuth *access token* (a `Bearer` in an `Authorization` header) authorizes
  calls to the app's REST API *as* the user. This is what "connected account" platforms broker.
- **A logged-in UI session** — an HttpOnly *session cookie* (plus localStorage/IndexedDB state)
  minted by the app's *own* backend at the end of *its* login flow, living in a browser's cookie
  jar. This is what a UI-driving agent needs.

These are **not interchangeable and there is no standard way to convert one into the other.**
A refresh token cannot be turned into a session cookie; the cookie is only ever minted through
the app's redirect flow in a browser ([id vs access token](https://www.loginradius.com/blog/identity/id-token-vs-access-token),
[OAuth vs OIDC](https://aembit.io/blog/oauth-vs-oidc-difference-when-to-use/)).

**Our agent is a UI driver.** The whole product is a *recorded demo of the app's UI*. So the
large, mature, production-grade world of OAuth token brokers (Nango, Arcade, Paragon, Auth0
Token Vault, Descope) solves a layer *adjacent* to ours — useful for a hypothetical
API-shortcut, not for putting the agent in front of a signed-in screen. Keep this distinction
in hand for §3 and §4; it eliminates half the options immediately.

---

## 1. Where we are today (so the brief builds on the code, not around it)

The repo already contains far more of the answer than the CLAUDE.md advertises. Before
proposing anything, here is the ground truth (verified by reading the code today):

- **There is a complete remote-execution layer — but it targets three *persistent physical
  Macs* over SSH, not cloud VMs.** `hosts.json` = `mac1/mac2/mac3` at colo IPs; `src/remote/*`
  provisions them via a GUI-domain LaunchAgent (`com.yarn.runner`) because macOS attributes
  Accessibility + Screen Recording to the *responsible* process — a run spawned from an sshd
  session gets an empty AX tree and a black screenshot with no error. **Zero cloud/VM/container
  code exists.** (grep for ec2/firecracker/orka/tart/macstadium/warm-pool: nothing.)
- **The sign-in flow David says is "not tenable" is already built and is deliberately
  human-in-the-loop, once per app per Mac.** `src/remote/signin.ts` opens a `vnc://` screen
  share, a human completes SSO+MFA by hand, `waitForHome` polls `runnerctl ready` for up to 20
  min, then `closeScreenShare` tidies up. Its docstring states the thesis plainly: *credentials
  must never enter the loop* (every observation + recorded frame goes to the model and into the
  demo video — a typed password is a live leak into two artifacts we hand to other people);
  *MFA/SSO are not automatable in the general case, and "the general case" is the requirement*;
  *it is once per app per Mac, and the session then lives in the app's own storage.*
- **Web logins already persist** via a driver-owned named Chrome profile (`browser-login.ts`,
  profile `yarn-runner`, `isolated_named` so the login survives runs). Not yet wired to fleet
  dispatch (`DispatchOptions` has no `url`).
- **Per-operator session isolation already exists** (`src/runner/profiles.ts`): it swaps nine
  classes of `~/Library` state (cookie jars, localStorage, `HTTPStorages`, `binarycookies`, …)
  per operator per app so teammates on one shared console account don't demo as each other. It
  is Electron-shaped by design and **documents its own gap**: *"An app that keeps its session
  token in the login keychain rather than in its own container is not isolated by moving
  directories… Electron apps keep session state in the Chromium cookie jar and localStorage
  under Application Support, which is exactly what moves."*

The significance for this brief: **we already have a working "session lives on a persistent
machine" architecture.** The question David is really asking is whether we can *break the
session's dependence on a specific persistent machine* so the machine can become an
ephemeral/cloud VM. That is exactly the session-portability problem — and §2 is why it's hard.

---

## 2. Why "capture the session and replay it from a cloud VM" is the hard road (and getting harder)

This is the mechanism David explicitly asked about — capture a token/session on the client and
send it to the remote machine. It *works* in narrow cases and is *actively being killed* in the
cases that matter. Here is the honest technical picture.

### 2a. What a transferable session actually is, and how you'd move it

The portable object is Playwright's **`storageState`** — a JSON blob of cookies + localStorage
(and IndexedDB) captured from an authenticated context and rehydrated into a fresh one
([Playwright auth](https://playwright.dev/docs/auth),
[storageState guide](https://www.browserstack.com/guide/playwright-storage-state)). This is the
same primitive every cloud-browser vendor exposes (§3). Real limits:

- **`sessionStorage` is not captured** (tab-scoped by design) — apps that stash a token there
  must have it re-seeded per context via an init script.
- **It goes stale** — session cookies and short-lived tokens expire; guidance is to regenerate
  every ~7 days. A captured blob is a depreciating asset, not a permanent key.
- **Cookies alone are often insufficient** — modern SPAs lean on localStorage/IndexedDB too,
  which `storageState` does cover, but any server-side binding (below) it cannot.
- **Capturing off the user's own machine** means reading Chrome's on-disk cookie DB, which on
  macOS is AES-encrypted under a Keychain-held key ("Chrome Safe Storage") and, since Chrome
  v20's **app-bound encryption**, increasingly bound to the writing app — i.e. first-party,
  consented extraction is *possible* but fragile and OS-version-sensitive. This is the messy,
  low-trust path even before the session leaves the laptop.

### 2b. The defenses — why a transplanted session dies on arrival

A session that suddenly appears from a datacenter IP with a different fingerprint is *exactly*
the signature of the attack every fraud team already defends against ("pass-the-cookie"). The
detection stack, roughly in order of how much it hurts us:

1. **IP / ASN / geolocation + "impossible travel."** Session issued to a laptop in NYC, then
   used from an AWS range in us-east-1 minutes later → flagged or forced re-auth. Mitigable
   (§2c) but the first thing that breaks.
2. **Device/browser fingerprint mismatch** — UA, Canvas/WebGL, fonts, TLS (JA3/JA4). Soft-edged
   and mimic-able, but a fresh cloud Chrome vs. the user's real browser is an easy mismatch to
   catch ([DBSC vs fingerprinting](https://cside.com/blog/dbsc-vs-device-fingerprinting)).
3. **Device Bound Session Credentials (DBSC)** — the decisive one. Chrome generates a key pair
   at login, stores the **private key in the TPM (Windows) / Secure Enclave (macOS)**, and
   roughly every five minutes proves possession before refreshing a short-lived cookie. A cookie
   moved to another machine **cannot reproduce the hardware-bound proof and dies by design.**
   Status: **GA on Windows in Chrome 146 as of April 9, 2026; macOS via Secure Enclave is the
   next release; Safari/Firefox not shipping it.** Google is the driver and the big providers
   (Google, Microsoft-grade) are the early adopters — i.e. it lands first exactly on the
   accounts our customers actually use.
   ([Google announcement](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/),
   [Chrome dev docs](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials),
   [Windows GA](https://developer.chrome.com/blog/dbsc-windows-announcement))
4. **Short-lived access + rotating refresh tokens** — shrink the useful life of any captured blob.
5. **WebAuthn / passkey re-auth** — device-bound private key + user-presence gesture on every
   assertion. **Cannot be delegated to a cloud process, and that is the security property, not a
   bug** ([passkeys + agents](https://www.corbado.com/blog/ai-agents-passkeys)).

**The trajectory is the point.** Even where cookie transfer works *today*, the platform layer is
moving to make it fail *tomorrow*, and it's moving fastest on the highest-value providers. Any
architecture whose seam is "transplant the user's real session to the cloud" is building on
ground the industry is deliberately eroding. It's a working demo now and a support-ticket
generator in a year.

### 2c. What you'd have to bolt on to make transfer survive (and why it's a treadmill)

To keep a transplanted session alive you'd need, per identity: a **residential/ISP proxy** that
egresses from the user's real region (ideally sticky for the whole run), plus **matched
locale/timezone/UA/viewport**, plus an **antidetect-browser-grade fingerprint clone**
(Multilogin/GoLogin/AdsPower territory) — and even then you're only defeating layers 1–2 and
buying time against 4. Layers 3 and 5 are unaffected. A genuinely elegant variant David's
question gestures at — **egress the cloud browser *through a relay on the user's own machine*** so
the traffic exits their real IP — solves the IP/geo layer cleanly and is worth noting, but it
(a) requires software running on the customer machine anyway (undercutting "seamless cloud") and
(b) still doesn't touch DBSC or passkeys. ([residential egress + locale matching](https://maskproxy.io/blog/proxy-location-mismatch-ip-dns-browser-locale-routing/))

**Honest reliability assessment for "capture on the user's machine, replay from a cloud VM":**
- Simple SPA web apps, cookie/localStorage sessions, no hardware binding: **works, with the §2c
  bolt-ons; expect periodic staleness re-capture.**
- Google/Microsoft-grade providers: **increasingly does not work** — DBSC + aggressive
  risk-scoring + passkey pushes. This is where our customers' identities increasingly live.
- Enterprise SSO (Okta/Entra/Duo): **do not build on transfer.** Conditional-access policies,
  device compliance, and step-up MFA treat a transplanted session as the incident they exist to
  catch.

---

## 3. The path the industry actually took: cloud-native login, not session theft

Here's the reframe that makes cloud seamless-*enough*. Every serious cloud-browser-for-agents
vendor faced this exact problem and **none of them settled on transplanting the user's home
browser session.** They converged on a three-layer architecture:

1. **A persisted profile** — a Chromium user-data-dir snapshot (cookies, localStorage,
   IndexedDB, service workers) attached to a fresh cloud browser at session start. Browserbase
   calls it a *Context*; Steel/Kernel/Hyperbrowser/Browser Use call it a *Profile*; Anchor a
   *Browser Profile*. Universal flow: create → start session with `persist: true` → **log in
   once inside the cloud browser** → close (state uploads) → future sessions start logged in.
   This is *our `browser-login.ts` + named profile, hosted.*
2. **An encrypted credential vault + login orchestrator** — username/password + **TOTP seed**
   stored once, injected into form fields *without ever entering the model's context*, replayed
   automatically when layer 1 goes stale. (Anchor *Identities*, Kernel *Managed Auth*, Steel
   *Credentials*, Skyvern *vaults*.) The 2026 frontier feature is **self-healing re-auth** —
   background health-checks that re-login before a task starts (Kernel, Anchor OmniConnect).
3. **Network + fingerprint consistency** — a geo-pinned residential/ISP proxy and a stable
   per-identity fingerprint, precisely because §2b layer 1–2 exists. Anchor built a VPN and
   Browserbase built "Verified" for exactly this.

The crucial move: in this model **the user authenticates *into the agent's environment*, once,
deliberately** — the session is *native to the cloud browser* rather than transplanted into it.
Fingerprint and (with a pinned proxy) IP stay coherent from birth, so §2b never fires. This is
consent-by-construction, not cookie theft, and it's what OpenAI's Operator/ChatGPT-agent and
Manus both ship: pause at the login wall, user takes over the virtual browser once, session
persists thereafter. ([OpenAI agent](https://help.openai.com/en/articles/11752874-chatgpt-agent),
[Manus login-state handling](https://dev.to/logto/how-manus-handles-login-state-and-user-credentials-in-the-cloud-browser-3ne4))

**Vendor cheat-sheet** (full detail available; the ones that matter for us):

| Vendor | Persist | Import external session? | Vault/MFA | Shape |
|---|---|---|---|---|
| **Steel.dev** | Profiles API | **Yes — `sessionContext` injects captured cookies+localStorage**; can export too | Credentials API (TOTP) beta | **Apache-2.0, self-hostable, same API** |
| **Browser Use** | Profiles | **Yes — CLI syncs your real local Chrome profile to cloud** | TOTP, 1Password | OSS lib + cloud |
| **Browserbase** | Contexts | Yes — `addCookies` + encrypted custom user-data-dir upload | No native TOTP; human via Live View | SaaS only |
| **Anchor** | Identities | Embeddable end-user login (user auths *into* cloud browser) | Broadest: TOTP/OTP/SMS/self-healing | SaaS |
| **Kernel** | Profiles (+ &lt;20ms unikernel resume) | Via login in Kernel browser | Managed Auth, health-checked re-auth | SaaS + OSS browser image |
| **Skyvern** | Sessions | Re-auths from creds each time | Deepest vault (Bitwarden/1Password/AzureKV) | OSS (AGPL) |

Two are directly relevant to David's exact "capture on client, send to remote" instinct:
**Steel's `sessionContext`** and **Browser Use's local-Chrome-profile sync** are the productized
versions of it — and note that *even the vendors who support import position it as the fallback*
for SSO/magic-link cases "where the vault cannot drive the login and you only need the resulting
cookies." The primary path is always log-in-once-in-the-cloud-browser.

What remains unsolved industry-wide (so we don't imagine we're behind): **passkeys**
(un-delegable), **SMS/push MFA without a human or mailbox integration**, the **security
regression of centralizing TOTP seeds**, and **concurrency** (one identity ≈ one profile ≈ one
live session; sites force-logout on concurrent use). No vendor has beaten these.

---

## 4. The cleanest answers avoid session portability entirely

Two approaches sidestep §2 by never moving a session:

**(a) A customer-provisioned "demo/automation" identity.** The customer's IdP provisions a
dedicated account (SCIM, like any employee), scoped to exactly the demo apps, with password +
a **TOTP seed enrolled specifically for the automation** (not a copy of a human's second
factor). The cloud agent logs in from scratch each run — fully headless, no human in the loop,
revocable in the customer's IdP, and it **sidesteps the passkey wall** because we control the
factor. This is the Skyvern pattern and it is the *cleanest* fit for "runs on Yarn's machines,
per-app onboarding budget." The cost is a **contract/ToS conversation**, not code: many SaaS
EULAs restrict robot/shared accounts and per-seat licensing applies. For a B2B vendor onboarding
a customer's app deliberately (our exact situation — Jasper's ~24h grounding budget *is* an
onboarding step), this is a reasonable ask to fold into the same conversation.

**(b) OAuth token broker — only if a target task can be done via API.** If some demo's action
has a clean API and needn't be *shown* as UI, Nango (self-hostable) / Arcade / Paragon give
"consent once in the user's browser, act server-side forever." But per §0 this yields API
access, not a UI session, so it's an optimization for specific steps, **not a substitute for the
UI-driving agent.** Flag it, don't build the product on it.

**Interactive-handoff mechanisms** (for the unavoidable-interaction cases), ranked by seam:
- **QR "linked device"** (WhatsApp/Notion-mobile-approves-desktop model) — the best UX in
  existence, but only works where the app vendor built a companion-device protocol. We can *ride*
  it when a target app has it (cloud browser shows the app's own QR, user scans with phone), not
  add it to an app that lacks it.
- **OAuth Device Authorization Grant (RFC 8628)** — user approves on their phone, cloud gets
  tokens. Elegant, but yields API tokens (§0 again) and enterprises increasingly disable it
  (its UX is indistinguishable from a phishing lure).
- **Push-to-approve / CIBA** — for out-of-band "agent needs a human yes" moments; authorizes
  actions/tokens, not sessions. Good for a step-up gate, not for establishing the session.

---

## 5. Recommendation for Yarn

**Do not architect the cloud path around transplanting the customer's real browser session.**
It demos today and degrades structurally (§2b), fastest on the accounts customers actually use.
David's "send a token from the client to the remote machine" instinct is sound as a *fallback*
and is productized (Steel `sessionContext`, Browser Use profile sync) — adopt that shape for the
narrow case, don't make it the spine.

**Instead, treat sign-in as a product surface (as the learnings doc already argued) and move it
from "persistent physical Mac" to "persistent cloud profile," in this order:**

1. **Reframe the goal honestly with Jasper.** The target isn't "zero-interaction cloud." It's
   "**one consented login per customer-app during onboarding, then unattended cloud runs
   thereafter**" — which is genuinely seamless from the customer's day-to-day view and matches
   the ~24h onboarding budget he already granted. This is a positioning win, not a concession:
   it's the same deal Operator/Manus/Browserbase all offer, and it's *defensible* against DBSC
   and passkeys where transfer is not.

2. **For web/Electron targets (the declared scope), the cloud unit becomes a persisted browser
   profile, not a Mac.** We already have the local version (`browser-login.ts` + `isolated_named`
   `yarn-runner` profile). The cloud version is: launch our *own* Chrome/Electron with a
   remote-debugging port, drive via CDP (the learnings doc §3 already recommends this actuator
   move — attaching to our own Chrome also deletes the `mintApprovalToken` consent-gate hack),
   and persist the user-data-dir to object storage keyed per customer-app. This is a
   **Steel-shaped** design and Steel is Apache-2.0 self-hostable if we don't want to build the
   storage/orchestration plumbing ourselves.

3. **Establish the session cloud-native, three ways, in preference order:**
   a. **Customer-provisioned demo identity** (§4a) — headless, revocable, passkey-proof. Fold
      into onboarding. *Best default for a B2B onboarding flow.*
   b. **One supervised login into the cloud profile** (Operator/Manus model) — a human does SSO+MFA
      once inside the agent's own persistent cloud browser; session is native, fingerprint/IP
      coherent from birth. This is our *current* `signin.ts` flow with the target moved from a
      colo Mac to a cloud profile — small conceptual delta, we keep the no-credentials-in-the-loop
      rule and the `home`-state health probe intact.
   c. **Import a captured `sessionContext`** (§2a) — only for apps where a. and b. can't drive
      the login (some magic-link/SSO cases). Accept staleness re-capture. Never for
      DBSC/passkey providers.

4. **Add the §3-layer-3 consistency kit** to whichever of b./c. we use: a per-identity pinned
   residential/ISP proxy (or a relay on a customer box if they'll run one) + matched
   locale/timezone/UA. This is the difference between a session that survives and one that
   trips risk-scoring on move.

5. **Keep the physical-Mac fleet for exactly one thing: native macOS-app targets.** The learnings
   doc and native-apps investigation agree native is out of scope for now, and cua's AX core is
   the moat there. If native ever returns, TCC-granted persistent Macs are unavoidable and cloud
   doesn't apply — that's a separate track, not a blocker on the web/Electron cloud path.

**What this buys.** Parallelism stops being "= machine count" (the per-Mac lease tax). Cloud
profiles scale horizontally; the scarce resource becomes the *session*, which is now a portable,
re-establishable artifact instead of a stateful asset welded to one box. That is precisely the
"leverage point is auth, not virtualization" the learnings doc pointed at — now with a concrete
build order.

**What to say plainly to Jasper.** Fully unattended cloud "act as the customer with zero
interaction ever" is not achievable in the general case in 2026, and the platforms are making it
*less* achievable on purpose (DBSC GA'd April 2026; passkeys un-delegable by design). What *is*
achievable, and what the whole cloud-agent industry ships, is one consented login per
customer-app at onboarding, then seamless unattended cloud runs — with a customer-provisioned
demo account being the cleanest path when the customer will grant one.

---

## Appendix — sources

Session transfer & defenses:
[Playwright auth](https://playwright.dev/docs/auth) ·
[storageState guide](https://www.browserstack.com/guide/playwright-storage-state) ·
[DBSC — Google](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/) ·
[DBSC — Chrome docs](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials) ·
[DBSC Windows GA (Chrome 146, Apr 2026)](https://developer.chrome.com/blog/dbsc-windows-announcement) ·
[DBSC vs device fingerprinting](https://cside.com/blog/dbsc-vs-device-fingerprinting) ·
[passkeys + AI agents](https://www.corbado.com/blog/ai-agents-passkeys) ·
[residential egress / locale matching](https://maskproxy.io/blog/proxy-location-mismatch-ip-dns-browser-locale-routing/)

Cloud-browser vendors:
[Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) ·
[Browserbase auth](https://docs.browserbase.com/platform/identity/authentication) ·
[Anchor docs](https://docs.anchorbrowser.io) ·
[Steel profiles](https://steel.dev/blog/profiles) ·
[steel-browser (Apache-2.0)](https://github.com/steel-dev/steel-browser) ·
[Kernel profiles](https://www.onkernel.com/blog/introducing-browser-profiles-for-kernel) ·
[Browser Use auth taxonomy](https://browser-use.com/posts/web-agent-authentication) ·
[Skyvern credentials](https://www.skyvern.com/docs/credentials/introduction) ·
[OpenAI ChatGPT agent](https://help.openai.com/en/articles/11752874-chatgpt-agent) ·
[Manus login-state](https://dev.to/logto/how-manus-handles-login-state-and-user-credentials-in-the-cloud-browser-3ne4)

Delegated auth / brokers:
[Nango](https://nango.dev/docs/guides/auth/auth-guide) ·
[Arcade authorized tool calling](https://docs.arcade.dev/en/guides/tool-calling/custom-apps/auth-tool-calling) ·
[Paragon ActionKit](https://www.useparagon.com/actionkit) ·
[Auth0 Token Vault](https://auth0.com/blog/auth0-token-vault-secure-token-exchange-for-ai-agents/) ·
[OAuth Device Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628.html) ·
[id vs access token](https://www.loginradius.com/blog/identity/id-token-vs-access-token)

Substrate:
[Cua cloud containers](https://cua.ai/blog/introducing-cua-cloud-containers) ·
[trycua/cua](https://github.com/trycua/cua)

Internal (this repo):
`docs/research/2026-07-30-cua-learnings-for-real-implementation.md` §2–3 ·
`src/remote/signin.ts` · `src/browser-login.ts` · `src/runner/profiles.ts` (keychain gap) ·
`docs/architecture.md`
