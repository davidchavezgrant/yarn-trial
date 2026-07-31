import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_LAUNCH_POLICY_KEY,
	AUTO_LAUNCH_PROTOCOLS,
	autoLaunchProtocolsPlist,
	autoLaunchWriteLines,
	CHROME_DOMAIN,
	CHROME_POLICY,
	type ChromePolicyState,
	chromePolicyProblems,
	chromePolicyWriteLines,
	describeChromePolicy,
	inspectChromePolicy,
	MANDATORY_PLISTS,
	parseDefaultsBool,
	readChromePolicy,
	RECOMMENDED_PLISTS,
} from "../src/remote/chrome-policy.js";

/**
 * Chrome's autofill/password policy — the control added after a liveview sign-in on mac2
 * streamed Chrome's autofill dropdown, listing real people's email addresses, to a teammate.
 *
 * Offline by construction. Every probe this module makes is an injected function, so nothing
 * here reads a plist, shells out to `defaults`, or can observe — let alone alter — the
 * developer's own Chrome. That is not incidental tidiness: the whole subject of this file is a
 * password store, and a test suite that touched one would be the bug.
 */

const HOME = "/Users/administrator";
const USER = "administrator";

/** A host with the policy nowhere. What every Mac looked like before this shipped. */
function nothingSet(): ChromePolicyState {
	return readChromePolicy(() => undefined, { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });
}

/** Reads from a map of path → plist contents, so a test states only the files that exist. */
function reader(files: Record<string, Record<string, unknown>>) {
	return (p: string): Record<string, unknown> | undefined => files[p];
}

const RECOMMENDED_PATH = RECOMMENDED_PLISTS[0].replace("__HOME__", HOME);
const MANAGED_PATH = MANDATORY_PLISTS[0];
const MANAGED_USER_PATH = MANDATORY_PLISTS[1].replace("__USER__", USER);

/** Every key set to false, as the provisioning script leaves them. */
const ALL_FALSE = Object.fromEntries(CHROME_POLICY.map((p) => [p.key, false]));

test("readChromePolicy__ReportsEveryKeyUnset__When__NoPlistCarriesThem", () => {
	const state = nothingSet();

	assert.equal(state.keys.length, CHROME_POLICY.length);
	assert.deepEqual(
		state.keys.map((k) => k.level),
		CHROME_POLICY.map(() => "unset"),
	);
});

test("readChromePolicy__ReportsRecommended__When__OnlyTheUserDomainCarriesTheKeys", () => {
	const state = readChromePolicy(reader({ [RECOMMENDED_PATH]: ALL_FALSE }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });

	assert.deepEqual(
		state.keys.map((k) => k.level),
		CHROME_POLICY.map(() => "recommended"),
	);
	assert.deepEqual(
		state.keys.map((k) => k.value),
		CHROME_POLICY.map(() => false),
	);
});

test("readChromePolicy__PrefersTheManagedValue__When__BothDomainsCarryTheKey", () => {
	// macOS resolves most-forced-first, and so must this: reporting the user value while a
	// managed one exists would describe a host that is not the host in front of you.
	const state = readChromePolicy(
		reader({ [MANAGED_PATH]: { AutofillAddressEnabled: false }, [RECOMMENDED_PATH]: { AutofillAddressEnabled: true } }),
		{ home: HOME, user: USER, autoLaunch: [], chromeInstalled: true },
	);
	const key = state.keys.find((k) => k.key === "AutofillAddressEnabled");

	assert.equal(key?.level, "mandatory");
	assert.equal(key?.value, false);
});

test("readChromePolicy__FindsTheKeys__When__ManagedPreferencesArePerUser", () => {
	// MDM files managed preferences per-user as well as machine-wide and Chrome reads both. A
	// grader that knew only the machine-wide path would call a properly enrolled Mac unpoliced.
	const state = readChromePolicy(reader({ [MANAGED_USER_PATH]: ALL_FALSE }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });

	assert.deepEqual(
		state.keys.map((k) => k.level),
		CHROME_POLICY.map(() => "mandatory"),
	);
});

test("readChromePolicy__ReportsTheKeyAsSet__When__ItsValueIsFalse", () => {
	// The regression this guards is a one-character one. The value being looked for IS `false`,
	// so any truthiness test — `doc[key]`, `!!doc[key]` — reports a correctly policed host as
	// unset, and the fleet lights up red for being right.
	const state = readChromePolicy(reader({ [RECOMMENDED_PATH]: ALL_FALSE }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });

	assert.equal(state.keys.every((k) => k.level !== "unset"), true, JSON.stringify(state.keys));
	assert.deepEqual(chromePolicyProblems(state), []);
});

test("chromePolicyProblems__NamesTheMissingKeys__When__ThePolicyWasNeverApplied", () => {
	const problems = chromePolicyProblems(nothingSet());

	assert.equal(problems.length, 1);
	for (const { key } of CHROME_POLICY) assert.match(problems[0], new RegExp(key));
	// The fix, not just the fault.
	assert.match(problems[0], /provision/);
});

test("chromePolicyProblems__StaysSilent__When__EveryKeyIsFalseAtRecommendedLevel", () => {
	// Recommended is the strongest level this fleet can reach without MDM (measured on mac2:
	// no passwordless sudo, no /Library/Managed Preferences, not MDM-enrolled). Grading it as a
	// fault would put a permanent red mark on every correctly provisioned host, which is how a
	// checklist stops being read.
	assert.deepEqual(chromePolicyProblems(readChromePolicy(reader({ [RECOMMENDED_PATH]: ALL_FALSE }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true })), []);
});

test("chromePolicyProblems__ReportsTheOverride__When__ThePolicyIsSetButNotToFalse", () => {
	// The sync-defeats-recommended case. `credentials_enable_service` is a syncable priority
	// pref and RECOMMENDED sits below the user store, so an account-delivered value silently
	// wins — invisible any other way, and the reason doctor re-reads the effective value
	// instead of trusting the provisioning step's word that it wrote something.
	const state = readChromePolicy(reader({ [RECOMMENDED_PATH]: { ...ALL_FALSE, PasswordManagerEnabled: true } }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });
	const problems = chromePolicyProblems(state);

	assert.equal(problems.length, 1);
	assert.match(problems[0], /PasswordManagerEnabled/);
	assert.match(problems[0], /overriding/);
	// And it must NOT tell someone to re-run a provision, which would not help.
	assert.match(problems[0], /MDM/);
});

test("chromePolicyProblems__StaysSilent__When__TheRunnerDidNotReportTheField", () => {
	// The compatibility arm, and it matters more than it looks: until every host is
	// re-provisioned an older runner answers doctor without this field at all, and grading a
	// question that was never asked would light up the whole fleet over nothing. Same rule
	// `screenLocked` follows.
	assert.deepEqual(chromePolicyProblems(undefined), []);
});

test("chromePolicyProblems__StaysSilent__When__ChromeIsNotInstalled", () => {
	// Policy is still written to such a host — installing Chrome later must not silently
	// reopen the hole — but a Mac with no Chrome has no dropdown to leak, so it is not a finding.
	assert.deepEqual(chromePolicyProblems(readChromePolicy(() => undefined, { home: HOME, user: USER, autoLaunch: [], chromeInstalled: false })), []);
});

test("chromePolicyProblems__WarnsAboutTheStaleRead__When__ChromeIsStillRunning", () => {
	// cfprefsd caches, and Chrome re-reads platform policy only periodically — so a freshly
	// policed host can still serve the old answer, which is precisely when someone is about to
	// start a sign-in and expect the dropdown to be gone.
	const state = readChromePolicy(reader({ [RECOMMENDED_PATH]: ALL_FALSE }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });
	const problems = chromePolicyProblems({ ...state, chromeRunning: true });

	assert.equal(problems.length, 1);
	assert.match(problems[0], /quit and reopen/);
});

test("chromePolicyProblems__DoesNotWarnAboutRestarting__When__NothingWasApplied", () => {
	// A running Chrome with no policy at all has one problem, not two: the missing policy. The
	// restart advice is noise until there is something for it to pick up.
	const problems = chromePolicyProblems({ ...nothingSet(), chromeRunning: true });

	assert.equal(problems.length, 1);
	assert.equal(/quit and reopen/.test(problems[0]), false);
});

test("inspectChromePolicy__ReadsTheEffectiveValue__When__DefaultsAnswers", () => {
	const asked: string[] = [];
	const state = inspectChromePolicy({
		home: HOME,
		user: USER,
		autoLaunch: [],
		readDefault: (domain, key) => {
			assert.equal(domain, CHROME_DOMAIN);
			asked.push(key);

			return "0\n";
		},
		exists: () => false,
		chromeInstalled: true,
	});

	assert.deepEqual(asked, CHROME_POLICY.map((p) => p.key));
	assert.deepEqual(state.keys.map((k) => k.value), CHROME_POLICY.map(() => false));
	// No managed plist on disk, so whatever `defaults` returned is a recommended-level value.
	assert.deepEqual(state.keys.map((k) => k.level), CHROME_POLICY.map(() => "recommended"));
});

test("inspectChromePolicy__ReportsMandatory__When__AManagedPlistExists", () => {
	// `defaults` reports a value without saying whether it is forced, so the level comes from
	// WHERE the value lives. Value from defaults, level from the file: neither alone is enough.
	const state = inspectChromePolicy({
		home: HOME,
		user: USER,
		autoLaunch: [],
		readDefault: () => "0",
		exists: (p) => p === MANAGED_PATH,
		chromeInstalled: true,
	});

	assert.deepEqual(state.keys.map((k) => k.level), CHROME_POLICY.map(() => "mandatory"));
});

test("inspectChromePolicy__ReportsUnset__When__DefaultsHasNoSuchKey", () => {
	const state = inspectChromePolicy({ home: HOME, user: USER, autoLaunch: [], readDefault: () => undefined, exists: () => false, chromeInstalled: true });

	assert.deepEqual(state.keys.map((k) => k.level), CHROME_POLICY.map(() => "unset"));
	assert.equal(chromePolicyProblems(state).length, 1);
});

test("inspectChromePolicy__DegradesToUnset__When__AProbeThrows", () => {
	// This runs inside `doctor`, on the process holding the fleet's TCC grants. A diagnostic
	// that can throw is a diagnostic that can take the fleet down, so every probe is contained.
	const state = inspectChromePolicy({
		home: HOME,
		user: USER,
		autoLaunch: [],
		readDefault: () => {
			throw new Error("defaults: command not found");
		},
		exists: () => {
			throw new Error("EPERM");
		},
		chromeInstalled: true,
	});

	assert.deepEqual(state.keys.map((k) => k.level), CHROME_POLICY.map(() => "unset"));
});

test("parseDefaultsBool__ReadsBothSpellings__When__GivenDefaultsOutput", () => {
	// `defaults read` prints 0/1 for a value it wrote, but false/true for one that arrived as a
	// plist <false/> through a configuration profile. Both mean the same thing to Chrome, so a
	// grader that understood only "0" would call a properly MDM-managed host misconfigured.
	for (const yes of ["1", "true", "YES", " 1\n"]) assert.equal(parseDefaultsBool(yes), true, yes);
	for (const no of ["0", "false", "NO", "0\n"]) assert.equal(parseDefaultsBool(no), false, no);
	// Anything else survives as itself rather than being flattened into a boolean, so the
	// problem message can say what was actually found.
	assert.equal(parseDefaultsBool("(dict)"), "(dict)");
});

test("chromePolicyWriteLines__CoversExactlyThePolicyTable__When__GeneratingTheInstaller", () => {
	// Generated from the same table the doctor grades against, on purpose. A hand-written script
	// beside a hand-written grader drifts, and the way it drifts is that a key lands in one of
	// them — after which the host reports itself clean while the dropdown is still armed. That
	// is worse than no control, because it is now also believed.
	const lines = chromePolicyWriteLines();

	assert.equal(lines.length, CHROME_POLICY.length);
	for (const { key, value } of CHROME_POLICY) {
		// Typed per value: `-bool` for the toggles, `-int` for the enumerated policies whose
		// off-value is 0. `-bool 0` would store a boolean where Chrome expects an integer, and
		// be silently ignored while `defaults read` still printed a plausible 0.
		const written = typeof value === "number" ? `-int ${value}` : `-bool ${String(value)}`;
		const line = lines.find((l) => l.includes(`defaults write "$DOMAIN" ${key} ${written}`));
		assert.ok(line, `no write line for ${key}`);
		// Written AND read back. The write's exit status is not the report: a `defaults write`
		// to a plist owned by another uid can fail without a nonzero exit.
		assert.match(line, new RegExp(`check ${key}`));
	}
});

test("chromePolicyWriteLines__SetsEveryKeyToFalse__When__GeneratingTheInstaller", () => {
	// The table is all disables. A `-bool true` reaching this script would enable the very
	// suggestion surface the module exists to close, so nothing may generate one.
	for (const line of chromePolicyWriteLines()) assert.equal(/-bool true/.test(line), false, line);
});

test("chromePolicyWriteLines__EmitsNoShellMetacharacters__When__GeneratingTheInstaller", () => {
	// The key names become a command line. They are literals in this repo today, so this guards
	// the next one added by copy-paste from a policy page.
	for (const { key } of CHROME_POLICY) assert.match(key, /^[A-Za-z][A-Za-z0-9]*$/, key);
});

test("describeChromePolicy__CountsWhatIsApplied__When__RenderingAStatusCell", () => {
	assert.equal(describeChromePolicy(undefined), "not reported");
	assert.match(describeChromePolicy(nothingSet()), new RegExp(`^0/${CHROME_POLICY.length}`));
	assert.equal(describeChromePolicy(readChromePolicy(() => undefined, { home: HOME, user: USER, autoLaunch: [], chromeInstalled: false })), "Chrome not installed");

	const applied = readChromePolicy(reader({ [RECOMMENDED_PATH]: ALL_FALSE }), { home: HOME, user: USER, autoLaunch: [], chromeInstalled: true });
	assert.equal(describeChromePolicy(applied), `${CHROME_POLICY.length}/${CHROME_POLICY.length} applied (recommended)`);
});

test("CHROME_POLICY__DisablesTheFormHistoryStore__When__ListingTheKeys", () => {
	/**
	 * The load-bearing assertion of this file, and the one worth reading the comment for.
	 *
	 * The leak was a dropdown listing SEVERAL DIFFERENT PEOPLE at several different
	 * organisations. Saved-password suggestions cannot produce that — they are scoped to one
	 * site's own usernames. Single-field form history can: it is keyed on the FIELD NAME, so a
	 * box called `email` on any page offers every address ever typed into any box called
	 * `email`. mac2 held 80 distinct email-shaped values in exactly those fields (measured
	 * 2026-07-31, counts only).
	 *
	 * That store is governed by `AutofillAddressEnabled` — Chromium wires it up as
	 * `IsAutocompleteEnabled() { return IsAutofillProfileEnabled(); }` — and NOT by anything
	 * with "password" in the name. `PasswordManagerEnabled` only stops new saves; its own
	 * documentation says previously saved passwords still work, and no Chrome policy disables
	 * password filling at all.
	 *
	 * So dropping AutofillAddressEnabled from this list would leave the observed leak wide open
	 * while the other two keys made the host grade clean.
	 */
	assert.ok(CHROME_POLICY.some((p) => p.key === "AutofillAddressEnabled"), "the form-history key is what closes the observed leak");
	// EVERY entry is a disable — `false`, or the 0 that means "off" for the policies Chrome
	// enumerates instead of toggling. The table must never turn a feature ON: that is the one
	// property making it safe to apply unattended across the fleet.
	assert.ok(CHROME_POLICY.every((p) => p.value === false || p.value === 0));
	// And the honesty requirement: the password entry must not claim to hide saved passwords.
	const pw = CHROME_POLICY.find((p) => p.key === "PasswordManagerEnabled");
	assert.match(pw?.why ?? "", /does NOT hide/);
});

test("CHROME_POLICY__KeepsTheManagedProfileInterstitialAway__When__ListingTheKeys", () => {
	// The mac3 blocker, 2026-07-31: a managed-Workspace sign-in raised
	// chrome://managed-user-profile-notice, which halts the OAuth chain AND is unreachable from
	// CDP (Chrome refuses injected input on privileged WebUI), forcing the whole sign-in onto
	// the SCK transport. BrowserSignin=0 stops the BROWSER profile from taking a Google account
	// at all, so the interstitial has nothing to fire on, while the WEB sign-in an OAuth handoff
	// needs is untouched. Verified effective on mac3: chrome://policy reports both as
	// Recommended/OK from the user domain — no root, no MDM, unlike the allowlist key.
	const signin = CHROME_POLICY.find((p) => p.key === "BrowserSignin");
	assert.equal(signin?.value, 0, "0 is 'no browser sign-in'; any other value re-arms the interstitial");
	assert.ok(CHROME_POLICY.some((p) => p.key === "SigninInterceptionEnabled" && p.value === false));
});

// --- The external-protocol allowlist (AutoLaunchProtocolsFromOrigins). Added for the CDP
// liveview sign-in flow: an OAuth handoff ends with the page launching the app's URL scheme,
// and Chrome's "Open <App>?" confirmation is browser chrome a page screencast cannot show.
// The table ships EMPTY — Yarn's scheme is written nowhere in this repo and must be read off
// a real handoff, never guessed — so these tests exercise the mechanism with explicit entries.

/** A state carrying only the allowlist key, at the given level. */
function allowlistState(level: "mandatory" | "recommended" | "unset"): ChromePolicyState {
	return { chromeInstalled: true, keys: [{ key: AUTO_LAUNCH_POLICY_KEY, level, ...(level === "unset" ? {} : { value: "(1 entry)" }) }] };
}

test("autoLaunchProtocolsPlist__RendersTheChromiumSchema__When__GivenEntries", () => {
	// The exact shape Chromium documents: an array of dicts, each REQUIRING both `protocol`
	// (bare scheme, no separator) and `allowed_origins` (URLBlocklist-style patterns).
	const xml = autoLaunchProtocolsPlist([{ protocol: "slack", allowedOrigins: ["https://slack.com", "*"] }]);

	assert.equal(
		xml,
		"<array><dict><key>allowed_origins</key><array><string>https://slack.com</string><string>*</string></array><key>protocol</key><string>slack</string></dict></array>",
	);
});

test("autoLaunchProtocolsPlist__ReturnsUndefined__When__TheTableIsEmpty", () => {
	assert.equal(autoLaunchProtocolsPlist([]), undefined);
});

test("AUTO_LAUNCH_PROTOCOLS__CarriesTheYarnEntry__When__ReadOffTheAppBundle", () => {
	// The tripwire the empty-table assertion promised: flipped 2026-07-31 when the scheme was
	// read off Yarn.app's Info.plist (CFBundleURLSchemes = ["yarn"]) and the origin off
	// app.asar's auth endpoints. The origin still wants confirming against a real handoff —
	// if that widens the table, widen this with it.
	assert.deepEqual(AUTO_LAUNCH_PROTOCOLS, [{ protocol: "yarn", allowedOrigins: ["https://y-prod-api.onrender.com"] }]);
});

test("autoLaunchProtocolsPlist__Throws__When__TheSchemeCarriesItsSeparator", () => {
	// Chromium matches the bare lowercase scheme and silently ignores "yarn:", "yarn://" and
	// "Yarn" — an entry it ignores grades the host clean while every handoff still stops.
	for (const wrong of ["yarn://", "yarn:", "Yarn"]) assert.throws(() => autoLaunchProtocolsPlist([{ protocol: wrong, allowedOrigins: ["*"] }]), /bare lowercase scheme/, wrong);
});

test("autoLaunchProtocolsPlist__Throws__When__AnOriginCouldBeShellOrXmlInput", () => {
	// The origins reach a single-quoted XML fragment on a `defaults write` command line, so
	// the alphabet has to be closed against both syntaxes at the point of generation.
	for (const wrong of ["https://a.com'; touch /tmp/x", "<script>", "https://a.com b", "https://a.com?next=x"])
		assert.throws(() => autoLaunchProtocolsPlist([{ protocol: "slack", allowedOrigins: [wrong] }]), /safe alphabet/, wrong);
});

test("autoLaunchProtocolsPlist__Throws__When__AnOriginCarriesAPath", () => {
	// Chromium ignores any pattern with a /path element — another set-but-ineffective shape,
	// refused here instead of silently dropped there.
	assert.throws(() => autoLaunchProtocolsPlist([{ protocol: "slack", allowedOrigins: ["https://a.com/oauth"] }]), /carries a path/);
	// The scheme's own "//" is not a path.
	assert.ok(autoLaunchProtocolsPlist([{ protocol: "slack", allowedOrigins: ["https://a.com"] }]));
});

test("autoLaunchProtocolsPlist__Throws__When__AProtocolHasNoOrigins", () => {
	// Chromium requires both fields, and an empty origin list allows nothing while reading as set.
	assert.throws(() => autoLaunchProtocolsPlist([{ protocol: "slack", allowedOrigins: [] }]), /no allowed_origins/);
});

test("autoLaunchWriteLines__EmitsNothing__When__TheTableIsEmpty", () => {
	// An empty table must keep the installer inert — the mechanism grades nothing it has no
	// data for. (The live table is non-empty since 2026-07-31, so this pins the [] arm only.)
	assert.deepEqual(autoLaunchWriteLines([]), []);
});

test("autoLaunchWriteLines__TargetsTheManagedDomain__When__GivenEntries", () => {
	const lines = autoLaunchWriteLines([{ protocol: "slack", allowedOrigins: ["https://slack.com"] }]).join("\n");

	// MANDATORY-ONLY: the policy's template has no can_be_recommended, so a recommended-level
	// value is rejected with a level error. The write therefore goes to /Library/Managed
	// Preferences (root, hence sudo -n under a BatchMode ssh)...
	assert.match(lines, /sudo -n defaults write "\/Library\/Managed Preferences\/\$DOMAIN" AutoLaunchProtocolsFromOrigins/);
	// ...and NEVER to the user domain, which would read back fine in `defaults` while Chrome
	// ignored it — the set-but-ineffective state this module exists to never manufacture.
	assert.equal(/defaults write "\$DOMAIN" AutoLaunchProtocolsFromOrigins/.test(lines), false);

	// The check demands the value be FORCED, not merely readable: the managed plist must
	// exist as well as the key answering.
	assert.match(lines, /\[ -f "\/Library\/Managed Preferences\/\$DOMAIN\.plist" \]/);
	assert.match(lines, /MISSING="\$MISSING AutoLaunchProtocolsFromOrigins"/);
});

test("chromePolicyProblems__FlagsTheAllowlist__When__ItIsUnset", () => {
	const problems = chromePolicyProblems(allowlistState("unset"));

	assert.equal(problems.length, 1);
	assert.match(problems[0], /external-protocol allowlist/);
	assert.match(problems[0], /root or an MDM profile/);
	// Its own message, never folded into the autofill one — the fix is different (root/MDM,
	// not a re-run of provision) and so is the thing at risk (a stalled handoff, not a leak).
	assert.equal(/saved form data/.test(problems[0]), false);
});

test("chromePolicyProblems__ReportsSetButIneffective__When__TheAllowlistArrivedBelowMandatory", () => {
	// The trap state: `defaults read` answers, describeChromePolicy could count it, and Chrome
	// rejects it with a level error — worse than unset because it is also believed.
	const problems = chromePolicyProblems(allowlistState("recommended"));

	assert.equal(problems.length, 1);
	assert.match(problems[0], /ignores it below mandatory/);
	assert.match(problems[0], /Managed Preferences|MDM/);
});

test("chromePolicyProblems__StaysSilent__When__TheAllowlistIsForced", () => {
	assert.deepEqual(chromePolicyProblems(allowlistState("mandatory")), []);
});

test("describeChromePolicy__CountsTheAllowlistOnlyAtMandatory__When__RenderingAStatusCell", () => {
	// The boolean keys count as applied at recommended; the allowlist only where Chrome will
	// actually honour it.
	assert.equal(describeChromePolicy(allowlistState("recommended")), "0/1 applied (recommended)");
	assert.equal(describeChromePolicy(allowlistState("mandatory")), "1/1 applied (mandatory)");
});
