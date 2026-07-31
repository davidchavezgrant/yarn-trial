/**
 * Keep Chrome's autofill and password UI out of a liveview sign-in stream.
 *
 * WHY THIS FILE EXISTS. `liveview` shows a teammate a single window on a colo Mac so they can
 * sign an app in by hand. On 2026-07-31 a sign-in on mac2 put Chrome's autofill dropdown into
 * that stream, listing real people's email addresses — a credential-adjacent leak into a
 * channel a *different* person is watching. The stream is already window-scoped and the
 * teammate is already trusted with the window; what nobody agreed to is the browser
 * volunteering everything it has ever been told, in a list, unprompted.
 *
 * WHAT WAS ACTUALLY ON THOSE MACS (measured 2026-07-31, read-only, counts only — no value was
 * ever read out of either store):
 *
 *   host   Login Data `logins`   Web Data `autofill`
 *   mac1   801                   1969
 *   mac2   801                   2123   (1200 distinct; 80 look like email addresses)
 *   mac3   797                   1849
 *
 * All three are signed into a Google account with `sync.has_setup_completed` true and
 * `passwords` in the synced set. On mac2 every one of the 801 credentials carries a row in the
 * login database's own `sync_entities_metadata` — i.e. the server knows about all of them.
 * That is why this module changes POLICY and never touches data: see the deletion note below.
 *
 * THE TWO DROPDOWNS ARE DIFFERENT FEATURES WITH DIFFERENT SWITCHES, and conflating them is the
 * mistake this comment exists to prevent:
 *
 *  1. **Single-field form history** — everything ever typed into an ordinary input, kept in
 *     `Web Data`.`autofill`. It is keyed on the FIELD NAME, not on the site, so a box called
 *     `email` on any page offers every address ever typed into any box called `email`. That is
 *     the only store that explains one list containing several different people at several
 *     different organisations, and mac2 holds 80 distinct email-shaped values in exactly those
 *     fields. Governed by `AutofillAddressEnabled` — NOT by anything with "password" in the
 *     name, and not by anything with "autocomplete" in the name either. Chromium wires it up
 *     as `IsAutocompleteEnabled() { return IsAutofillProfileEnabled(); }`
 *     (components/autofill/core/common/autofill_prefs.cc), and the suggestion generator bails
 *     when that is false. The policy's own documentation only mentions addresses, so this is
 *     read off the source rather than off the docs.
 *
 *  2. **Saved passwords** — `Login Data`, offered on a login form for that site's own saved
 *     usernames. `PasswordManagerEnabled: false` does NOT hide these. Its documented text is
 *     explicit: "users can't save new passwords, but previously saved passwords will still
 *     work", and in code only `IsSavingAndFillingEnabled()` consults the pref while
 *     `IsFillingEnabled()` never does. **There is no Chrome policy that disables password
 *     filling.** It is set below anyway — a shared colo Mac should stop ACCUMULATING other
 *     people's credentials every time someone signs in through liveview — but it must not be
 *     described as the fix for the dropdown, because it is not one. Closing that half means
 *     clearing the store, which is a separate, deliberate, and (see below) risky decision.
 *
 * WHY POLICY AND NOT THE PROFILE'S `Preferences` JSON. The tempting one-liner is to write
 * `credentials_enable_service: false` straight into the profile. It is registered
 * `SYNCABLE_PRIORITY_PREF` (components/password_manager/core/browser/password_manager.cc), so
 * that write would be picked up by sync and pushed to the signed-in Google account's OTHER
 * devices — someone's personal laptop silently losing its password manager because we tidied a
 * colo Mac. Policy values live outside the profile and never sync. Not negotiable.
 *
 * WHY RECOMMENDED LEVEL, AND WHAT THAT COSTS. macOS decides policy level by whether the value
 * is *forced*: `/Library/Managed Preferences/…` is MANDATORY, `~/Library/Preferences/…` is
 * RECOMMENDED (`policy_loader_mac.mm`). Mandatory needs root — and measured on mac2, the fleet
 * account has no passwordless sudo, `/Library/Managed Preferences` does not exist, and the Mac
 * is not MDM-enrolled — while provisioning is a non-interactive `BatchMode=yes` ssh that cannot
 * answer a password prompt. So recommended is what this path can reach unattended, and all
 * three keys below accept it (`can_be_recommended: true`, and none is on Chromium's 20-entry
 * `sensitive:` list that unmanaged Macs filter out).
 *
 * The cost is real and is reported rather than hidden: RECOMMENDED sits BELOW the user store in
 * `pref_value_store.h`, so an explicit user value wins — including one delivered by sync, since
 * sync writes into the user store. Today nothing defeats it: on mac2 `credentials_enable_service`
 * and `autofill.profile_enabled` are both absent from the profile, so the recommended value is
 * the effective one. If that ever changes, `chromePolicyProblems()` is what says so, and the
 * fix is a real MDM configuration profile.
 *
 * DELETION IS NOT DONE HERE AND MUST NOT BE ADDED HERE. Removing rows from `Login Data` while
 * Chrome is running goes through `PasswordStoreChange::REMOVE`, which commits a sync tombstone
 * and deletes the credential from the account's vault and every other device the person owns.
 * Deleting the FILE instead has the opposite failure: it destroys `sync_model_metadata`, so the
 * next launch re-runs initial sync and re-downloads everything from the server. Neither is ours
 * to do to somebody's real Google account from a provisioning script.
 */

/** The preference domain. Chrome's bundle id, which is also the plist basename. */
export const CHROME_DOMAIN = "com.google.Chrome";

/**
 * Where macOS looks, most-forced first. The first two are written only by MDM and make a value
 * MANDATORY; the last two are ordinary preference domains and make it RECOMMENDED.
 *
 * `__USER__` is substituted with the console account. Managed preferences are filed per-user as
 * well as machine-wide and Chrome reads both, so a fleet that ever does get enrolled must not
 * be graded as unpoliced just because the payload landed in the per-user path.
 */
export const MANDATORY_PLISTS = [`/Library/Managed Preferences/${CHROME_DOMAIN}.plist`, `/Library/Managed Preferences/__USER__/${CHROME_DOMAIN}.plist`];

export const RECOMMENDED_PLISTS = [`__HOME__/Library/Preferences/${CHROME_DOMAIN}.plist`, `/Library/Preferences/${CHROME_DOMAIN}.plist`];

export interface ChromePolicyKey {
	key: string;
	/** Every policy here is a disable. Typed as the literal so a future `true` is a compile error. */
	value: false;
	/** What it actually buys, in one line. The long form is in this file's header. */
	why: string;
}

/**
 * The policy set, in the order a reader should meet it: the one that closes the observed leak
 * first, then the two that reduce what there is to leak next time.
 *
 * Deliberately short. Every additional key is another thing that can be wrong on a host, and
 * the three below are the ones with a measured reason to exist.
 */
export const CHROME_POLICY: ChromePolicyKey[] = [
	{
		key: "AutofillAddressEnabled",
		value: false,
		why: "suppresses single-field form history — the store that can list several people's addresses in one dropdown",
	},
	{
		key: "AutofillCreditCardEnabled",
		value: false,
		why: "same suppression for card suggestions; a payment sheet in a shared stream is strictly worse",
	},
	{
		key: "PasswordManagerEnabled",
		value: false,
		why: "stops NEW credentials being saved on a shared Mac — does NOT hide already-saved ones, no policy does",
	},
];

/**
 * A key name reaches a `defaults write` command line inside a staged shell script, so it is
 * checked at the point it becomes a command rather than trusted for being a literal in this
 * file. Cheap, and it means a future key added by copy-paste from a web page cannot carry
 * anything a shell would read.
 */
const BARE_POLICY_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * The external-protocol allowlist — a different dialog from the three keys above, same
 * mechanism, same file, so there is exactly one way this repo sets Chrome policy.
 *
 * WHY. A sign-in's OAuth handoff ends with the page launching the app's own URL scheme, and
 * Chrome interposes its "Open <App>.app?" confirmation. That dialog is browser chrome: a CDP
 * `Page.startScreencast` shows only the page, so to a liveview teammate the sign-in just
 * stops (src/remote/liveview-cdp.ts — the SCK engine auto-presses exactly this dialog; the
 * CDP engine cannot see it to press it). `AutoLaunchProtocolsFromOrigins` is Chromium's
 * sanctioned way to skip the dialog for a named scheme launched from named origins
 * (schema: an array of {protocol, allowed_origins} dicts, Chrome 85+).
 *
 * MANDATORY-ONLY, unlike the keys above. The policy's template metadata carries no
 * `can_be_recommended`, and its published docs say "Can be recommended: No" outright — a
 * value arriving at recommended level is rejected with a level error, not applied. On this
 * fleet the unattended path reaches ONLY recommended (no passwordless sudo, no MDM — see the
 * header), so the write lines target /Library/Managed Preferences via `sudo -n` and report
 * missing when that fails, rather than writing a user-domain value that reads back fine in
 * `defaults` while Chrome ignores it. Set-but-ineffective is the one state this file must
 * never manufacture — it is the believed-but-armed failure the header calls worse than none.
 */
export const AUTO_LAUNCH_POLICY_KEY = "AutoLaunchProtocolsFromOrigins";

export interface AutoLaunchProtocolEntry {
	/**
	 * The scheme with NO separator and in lowercase: "slack", never "slack:", "slack://" or
	 * "Skype" — Chromium matches the bare lowercase scheme and silently ignores the rest.
	 */
	protocol: string;
	/**
	 * URLBlocklist-style origin patterns allowed to launch the scheme without the dialog:
	 * "https://accounts.google.com", "example.com", "*". A path or query part makes Chromium
	 * ignore the whole pattern, so the validator refuses them here instead.
	 */
	allowedOrigins: string[];
}

/**
 * The scheme is READ, not guessed (rule: a wrong scheme grades the host clean while every
 * handoff still stops on the dialog). Provenance, 2026-07-31:
 *   - protocol "yarn": Yarn.app's own registration — Info.plist CFBundleURLTypes[0]
 *     .CFBundleURLSchemes = ["yarn"] (app bundle v0.0.119, read via plutil).
 *   - origin: the app's auth endpoints all live at https://y-prod-api.onrender.com
 *     (/auth/google, /auth/google-web, /auth/sso — strings in app.asar). That is the origin
 *     expected to fire the yarn:// return; CONFIRM against a real handoff before trusting a
 *     graded-clean host, and widen here if the dialog names a different origin.
 */
export const AUTO_LAUNCH_PROTOCOLS: AutoLaunchProtocolEntry[] = [
	{ protocol: "yarn", allowedOrigins: ["https://y-prod-api.onrender.com"] },
];

/** Chromium's own constraint (bare, lowercase) — which also keeps the XML below inert in a shell. */
const BARE_PROTOCOL = /^[a-z][a-z0-9+.-]*$/;

/**
 * An origin pattern reaches a single-quoted XML fragment on a `defaults write` command line,
 * so its alphabet is closed twice over: nothing XML-special, nothing shell-special. The slash
 * is allowed only as a scheme's "//" — Chromium ignores any pattern carrying a path or query,
 * and an ignored entry is a host grading clean while the dialog stays.
 */
function checkOriginPattern(origin: string): void {
	if (!/^[A-Za-z0-9*.:/-]+$/.test(origin))
		throw new Error(`auto-launch origin ${JSON.stringify(origin)} is outside the safe alphabet — it would reach a shell inside an XML fragment`);
	if (origin.replace(/^[A-Za-z*][A-Za-z0-9+.*-]*:\/\//, "").includes("/"))
		throw new Error(`auto-launch origin ${JSON.stringify(origin)} carries a path — Chromium silently ignores such patterns, which reads as set while the dialog stays`);
}

/**
 * The policy value as the XML plist fragment `defaults write` accepts, generated from the
 * table so the value and its grader cannot drift. Undefined when there is nothing to write.
 */
export function autoLaunchProtocolsPlist(entries: AutoLaunchProtocolEntry[] = AUTO_LAUNCH_PROTOCOLS): string | undefined {
	if (!entries.length) return undefined;

	const dicts = entries.map(({ protocol, allowedOrigins }) => {
		if (!BARE_PROTOCOL.test(protocol))
			throw new Error(`auto-launch protocol ${JSON.stringify(protocol)} is not a bare lowercase scheme — write "slack", never "slack:" or "slack://" (Chromium ignores the separator forms, and this string reaches a shell)`);
		if (!allowedOrigins.length)
			throw new Error(`auto-launch protocol ${JSON.stringify(protocol)} has no allowed_origins — Chromium requires both fields, and an empty list allows nothing while reading as set`);
		for (const origin of allowedOrigins) checkOriginPattern(origin);

		return `<dict><key>allowed_origins</key><array>${allowedOrigins.map((o) => `<string>${o}</string>`).join("")}</array><key>protocol</key><string>${protocol}</string></dict>`;
	});

	return `<array>${dicts.join("")}</array>`;
}

/**
 * The script section that applies the allowlist — same generated-not-hand-written rule as
 * `chromePolicyWriteLines`, and empty while the table is, so today's installer is unchanged.
 *
 * `sudo -n`: mandatory on macOS means /Library/Managed Preferences, which needs root, and
 * provisioning is a BatchMode ssh that cannot answer a password prompt — so the write is
 * attempted without one and its failure is a report, not a crash. The check requires the
 * managed plist to EXIST as well as the key to read back: a value visible to `defaults` but
 * not forced is precisely the ignored-below-mandatory state the table header warns about,
 * and it must grade as missing.
 */
export function autoLaunchWriteLines(entries: AutoLaunchProtocolEntry[] = AUTO_LAUNCH_PROTOCOLS): string[] {
	const plist = autoLaunchProtocolsPlist(entries);
	if (!plist) return [];

	return [
		`# lets the OAuth handoff launch ${entries.map((e) => e.protocol).join(", ")} from its own sign-in origins with no "Open <App>?" dialog — browser chrome a CDP liveview cannot show`,
		`sudo -n defaults write "/Library/Managed Preferences/$DOMAIN" ${AUTO_LAUNCH_POLICY_KEY} '${plist}' 2>/dev/null || true`,
		`if [ -f "/Library/Managed Preferences/$DOMAIN.plist" ] && defaults read "$DOMAIN" ${AUTO_LAUNCH_POLICY_KEY} >/dev/null 2>&1; then`,
		`\tAPPLIED=$((APPLIED + 1))`,
		`else`,
		`\tMISSING="$MISSING ${AUTO_LAUNCH_POLICY_KEY}"`,
		`fi`,
	];
}

/**
 * Everything the graders scan: the boolean table, plus the allowlist key once it has entries.
 * `entries` is injectable so grading tests pin their own policed set instead of inheriting
 * whatever the live table holds this week (filling it broke eight of them once already).
 */
function policedKeyNames(entries: AutoLaunchProtocolEntry[] = AUTO_LAUNCH_PROTOCOLS): string[] {
	return [...CHROME_POLICY.map((p) => p.key), ...(entries.length ? [AUTO_LAUNCH_POLICY_KEY] : [])];
}

export type PolicyLevel = "mandatory" | "recommended" | "unset";

export interface ChromePolicyKeyState {
	key: string;
	level: PolicyLevel;
	/** What Chrome will read. Absent when the key is unset everywhere. */
	value?: unknown;
}

export interface ChromePolicyState {
	/**
	 * Whether Chrome is on the host at all. A Mac without Chrome is not a finding — but the
	 * policy is still written, so installing Chrome later cannot silently reopen the hole.
	 */
	chromeInstalled: boolean;
	keys: ChromePolicyKeyState[];
	/**
	 * Chrome was running when this was read. Platform policy is re-read periodically rather than
	 * on write, so a running Chrome may still be serving the old answer — which matters because
	 * the next thing an operator does is start a sign-in and expect the dropdown to be gone.
	 */
	chromeRunning?: boolean;
}

/** Reads one plist into a plain object. Injected so the graders below are testable offline. */
export type PlistReader = (path: string) => Record<string, unknown> | undefined;

/**
 * Resolve the effective level and value of every policy key.
 *
 * Most-forced-first, matching `CFPreferencesCopyAppValue`'s own search order: a managed value
 * wins over a user one, and reporting the user one while a managed one exists would describe a
 * host that is not the host in front of you.
 */
export function readChromePolicy(
	read: PlistReader,
	opts: { home: string; user: string; chromeInstalled: boolean; chromeRunning?: boolean; autoLaunch?: AutoLaunchProtocolEntry[] },
): ChromePolicyState {
	const expand = (p: string): string => p.replace("__HOME__", opts.home.replace(/\/+$/, "")).replace("__USER__", opts.user);
	const sources: [PolicyLevel, Record<string, unknown> | undefined][] = [
		...MANDATORY_PLISTS.map((p): [PolicyLevel, Record<string, unknown> | undefined] => ["mandatory", read(expand(p))]),
		...RECOMMENDED_PLISTS.map((p): [PolicyLevel, Record<string, unknown> | undefined] => ["recommended", read(expand(p))]),
	];

	return {
		chromeInstalled: opts.chromeInstalled,
		...(opts.chromeRunning === undefined ? {} : { chromeRunning: opts.chromeRunning }),
		keys: policedKeyNames(opts.autoLaunch).map((key) => {
			for (const [level, doc] of sources) {
				// `in`, not a truthiness test: the value we want to find is `false`, and every
				// shorter spelling of this check reports a correctly-policed host as unset.
				if (doc && key in doc) return { key, level, value: doc[key] };
			}

			return { key, level: "unset" as PolicyLevel };
		}),
	};
}

/**
 * Everything wrong that an operator can act on. Empty means the host will not volunteer a
 * dropdown into the next sign-in stream.
 *
 * A RECOMMENDED level is not a problem — it is the strongest this fleet can reach without MDM,
 * and grading it as a fault would put a permanent red mark on every correctly-provisioned host,
 * which is how a checklist stops being read. What IS a problem is a key that is unset, or one
 * whose effective value is not the one we asked for: that second case is the sync-defeats-
 * recommended scenario the header describes, and it is invisible any other way.
 */
export function chromePolicyProblems(state: ChromePolicyState | undefined): string[] {
	// Absent from the payload means a runner too old to report it, not a host that failed. The
	// same rule `screenLocked` follows: never grade a question that was never asked.
	if (!state) return [];
	if (!state.chromeInstalled) return [];

	const problems: string[] = [];
	const unset = state.keys.filter((k) => k.level === "unset" && k.key !== AUTO_LAUNCH_POLICY_KEY);
	if (unset.length)
		problems.push(
			`Chrome autofill policy not applied (${unset.map((k) => k.key).join(", ")}) — a sign-in stream can show saved form data to whoever is watching: ./run provision --host <name>`,
		);

	// Set, but not to false. Only reachable when something outranks us — in practice a synced
	// user preference beating a recommended policy — so the message names that rather than
	// telling someone to re-run a provision that will not help.
	for (const k of state.keys)
		if (k.key !== AUTO_LAUNCH_POLICY_KEY && k.level !== "unset" && k.value !== false)
			problems.push(`Chrome policy ${k.key} is ${JSON.stringify(k.value)} at ${k.level} level, not false — a user or synced preference is overriding it; this needs an MDM profile to enforce`);

	// The allowlist grades on LEVEL, not value: Chromium rejects this policy below mandatory
	// with a level error, so "set at recommended" is set-but-ineffective — it reads back fine
	// in `defaults` while every handoff still stops on the dialog, which is strictly worse
	// than unset because it is also believed. Only in the scan at all once the table has
	// entries, so an empty table grades nothing.
	const auto = state.keys.find((k) => k.key === AUTO_LAUNCH_POLICY_KEY);
	if (auto && auto.level === "unset")
		problems.push(
			`Chrome external-protocol allowlist (${AUTO_LAUNCH_POLICY_KEY}) not applied — a sign-in's OAuth handoff stops on the "Open <App>?" dialog, which a CDP liveview cannot show; the policy is mandatory-only, so this needs root or an MDM profile`,
		);
	else if (auto && auto.level !== "mandatory")
		problems.push(
			`Chrome policy ${AUTO_LAUNCH_POLICY_KEY} is at ${auto.level} level and Chrome ignores it below mandatory — it reads as set while the "Open <App>?" dialog still appears; move it to /Library/Managed Preferences (root) or an MDM profile`,
		);

	if (state.chromeRunning && state.keys.some((k) => k.level !== "unset"))
		problems.push("Chrome is running, and it re-reads platform policy only periodically — quit and reopen it before trusting a sign-in stream");

	return problems;
}

/**
 * Read the policy as it stands on THIS machine. Runs on the fleet Mac, inside the runner's
 * `doctor`.
 *
 * `defaults read <domain> <key>` rather than parsing the plists directly, and that is the whole
 * point of the call: `defaults` goes through `cfprefsd`, which applies the same search order and
 * the same cache Chrome itself sees. Reading the files by hand would answer a subtly different
 * question — what is on disk — and on macOS those two answers diverge routinely, because
 * `cfprefsd` caches and a hand-edited plist can be live in one and stale in the other.
 *
 * The level still needs the file check, because `defaults` reports a value without saying
 * whether it is forced. Hence: `defaults` for the effective VALUE, file presence for the LEVEL.
 *
 * Every probe is individually fallible and none of them can fail the caller. This runs inside
 * `doctor` on the process that holds the fleet's TCC grants; a throw here would take a
 * diagnostic and turn it into an outage.
 */
export function inspectChromePolicy(opts: {
	home: string;
	user: string;
	/** `defaults read <domain> <key>`, or undefined when the key is unset. Injected in tests. */
	readDefault: (domain: string, key: string) => string | undefined;
	exists: (path: string) => boolean;
	chromeInstalled: boolean;
	chromeRunning?: boolean;
}): ChromePolicyState {
	const expand = (p: string): string => p.replace("__HOME__", opts.home.replace(/\/+$/, "")).replace("__USER__", opts.user);
	// Level is a property of WHERE a value lives, and only a managed plist forces one. Computed
	// once: it is the same answer for every key.
	const forced = MANDATORY_PLISTS.some((p) => {
		try {
			return opts.exists(expand(p));
		} catch {
			return false;
		}
	});

	return {
		chromeInstalled: opts.chromeInstalled,
		...(opts.chromeRunning === undefined ? {} : { chromeRunning: opts.chromeRunning }),
		keys: policedKeyNames().map((key): ChromePolicyKeyState => {
			let raw: string | undefined;
			try {
				raw = opts.readDefault(CHROME_DOMAIN, key);
			} catch {
				raw = undefined;
			}
			if (raw === undefined) return { key, level: "unset" };

			return { key, level: forced ? "mandatory" : "recommended", value: parseDefaultsBool(raw) };
		}),
	};
}

/**
 * `defaults read` prints a boolean as `0`/`1`, but the same command prints `false`/`true` for a
 * value that reached the domain as a plist `<false/>` through a configuration profile. Both
 * spellings mean the same thing to Chrome, so both have to parse — a grader that understood only
 * `0` would report a correctly MDM-managed host as misconfigured.
 *
 * Anything else is returned as the trimmed string rather than coerced, so `chromePolicyProblems`
 * can say what it actually found instead of flattening a surprise into `false`.
 */
export function parseDefaultsBool(raw: string): boolean | string {
	const t = raw.trim();
	if (t === "0" || t === "false" || t === "NO") return false;
	if (t === "1" || t === "true" || t === "YES") return true;

	return t;
}

/** One line for a status table. */
export function describeChromePolicy(state: ChromePolicyState | undefined): string {
	if (!state) return "not reported";
	if (!state.chromeInstalled) return "Chrome not installed";
	const levels = state.keys.map((k) => k.level);
	// The allowlist counts as applied only where Chrome will honour it — at mandatory level.
	const applied = state.keys.filter((k) => (k.key === AUTO_LAUNCH_POLICY_KEY ? k.level === "mandatory" : k.level !== "unset" && k.value === false)).length;

	return `${applied}/${state.keys.length} applied${levels.includes("mandatory") ? " (mandatory)" : levels.includes("recommended") ? " (recommended)" : ""}`;
}

/**
 * The `defaults write` lines that apply the policy, generated FROM the table above rather than
 * written out beside it.
 *
 * Generated on purpose: a hand-written script and a hand-written grader drift, and the way they
 * drift is that a key gets added to one of them. Then the host reports itself clean while the
 * dropdown is still armed — the precise failure mode that makes a security control worse than
 * none, because it is now also believed.
 */
export function chromePolicyWriteLines(): string[] {
	return CHROME_POLICY.map(({ key, value, why }) => {
		if (!BARE_POLICY_KEY.test(key)) throw new Error(`Chrome policy key ${JSON.stringify(key)} is not a bare identifier — it would reach a shell as a command line`);

		// `defaults write` of a single key rewrites only that key: the existing plist on all three
		// Macs holds `LastRunAppBundlePath`, which Chrome wrote and which must survive (103 bytes,
		// measured 2026-07-31). Writing the whole plist instead would take it with us.
		//
		// `|| true` because the write is not the report. A failed write must fall through to
		// `check`, which reads the value back — under `set -e` an unguarded failure would abort
		// the script before it could say WHICH key did not take.
		return `# ${why}\ndefaults write "$DOMAIN" ${key} -bool ${String(value)} 2>/dev/null || true\ncheck ${key}`;
	});
}
