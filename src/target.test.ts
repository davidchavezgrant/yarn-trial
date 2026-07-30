import assert from "node:assert/strict";
import test from "node:test";
import { appSlug } from "./harness.js";
import {
	buildRunArgs,
	isBrowserApp,
	parseTarget,
	type Target,
	TargetError,
	targetLabel,
	targetSlug,
	targetVocabulary,
	webTarget,
} from "./target.js";

const YARN: Target = { kind: "app", name: "Yarn" };
const NOTION = webTarget("https://www.notion.so");

test("parseTarget__ReturnsTheFallbackApp__When__NoUrlFlagGiven", () => {
	const { target, rest } = parseTarget(["show me how to X", "Yarn"], "Yarn");
	assert.deepEqual(target, { kind: "app", name: "Yarn" });
	assert.deepEqual(rest, ["show me how to X", "Yarn"]);
});

test("parseTarget__ConsumesTheFlagPair__When__UrlGiven", () => {
	// The positionals either side must survive: explore reads guidance from positional 1 and
	// agent reads the task from positional 0, and neither should see the flag.
	const { target, rest } = parseTarget(["do a thing", "--url", "https://www.notion.so", "extra"], "Yarn");
	assert.equal(target.kind, "web");
	assert.deepEqual(rest, ["do a thing", "extra"]);
});

test("parseTarget__Throws__When__UrlFlagHasNoValue", () => {
	assert.throws(() => parseTarget(["--url"], "Yarn"), TargetError);
	assert.throws(() => parseTarget(["--url", "--record"], "Yarn"), TargetError);
});

test("webTarget__Throws__When__SchemeIsNotHttp", () => {
	// browser_navigate accepts http/https/about only; catching it here turns a mid-run
	// driver refusal into a startup argument error.
	assert.throws(() => webTarget("file:///etc/passwd"), TargetError);
	assert.throws(() => webTarget("ftp://example.com"), TargetError);
	assert.throws(() => webTarget("javascript:alert(1)"), TargetError);
});

test("webTarget__Throws__When__SchemeIsMissing", () => {
	assert.throws(() => webTarget("www.notion.so"), TargetError);
});

test("webTarget__KeepsThePath__When__UrlIsADeepLink", () => {
	const t = webTarget("https://www.notion.so/my/deep/page");
	assert.equal(t.kind, "web");
	if (t.kind !== "web") return;
	assert.match(t.url, /\/my\/deep\/page$/);
	assert.equal(t.origin, "https://www.notion.so");
});

test("targetSlug__IsUnchangedFromAppSlug__When__TargetIsAMacApp", () => {
	// Load-bearing: appSlug has six call sites across the runner, fleet and shell, and
	// paths.test.ts pins the artifact paths. A Mac app's artifacts must not move.
	for (const name of ["Yarn", "Notion Calendar", "Google Chrome"])
		assert.equal(targetSlug({ kind: "app", name }), appSlug(name));
});

test("targetSlug__DerivesFromHost__When__TargetIsWeb", () => {
	assert.equal(targetSlug(NOTION), "web-www.notion.so");
});

test("targetSlug__IgnoresThePath__When__TwoUrlsShareAHost", () => {
	// One pass maps a site; two routes through it are not two apps.
	assert.equal(
		targetSlug(webTarget("https://www.notion.so/calendar")),
		targetSlug(webTarget("https://www.notion.so/teamspace")),
	);
});

test("targetSlug__ProducesNoPathSeparators__When__UrlIsHostile", () => {
	// A slug becomes a filename. Anything that could escape docs/appmaps/ must not survive.
	for (const raw of ["https://ex.com/../../etc", "https://user:pw@ex.com:8443/x?y=1#z"]) {
		const slug = targetSlug(webTarget(raw));
		assert.ok(!slug.includes("/"), `slug contains a slash: ${slug}`);
		assert.ok(!slug.includes(".."), `slug contains a traversal: ${slug}`);
		assert.ok(!slug.includes(":"), `slug contains a colon: ${slug}`);
		assert.match(slug, /^web-[a-z0-9.-]+$/);
	}
});

test("targetSlug__DropsCredentials__When__UrlCarriesThem", () => {
	// A password must never reach a filename that gets committed or pulled off the fleet.
	assert.equal(targetSlug(webTarget("https://user:secret@www.notion.so/x")), "web-www.notion.so");
});

test("targetSlug__Lowercases__When__HostIsMixedCase", () => {
	assert.equal(targetSlug(webTarget("https://WWW.Notion.SO")), "web-www.notion.so");
});

test("targetLabel__IsTheAppName__When__TargetIsAnApp", () => {
	assert.equal(targetLabel(YARN), "Yarn");
});

test("targetLabel__IsTheHost__When__TargetIsWeb", () => {
	assert.equal(targetLabel(webTarget("https://www.notion.so/deep/link")), "www.notion.so");
});

test("buildRunArgs__MatchesTheLegacyShape__When__TargetIsAnApp", () => {
	// Exactly what RunController.start built before this function existed.
	assert.deepEqual(buildRunArgs(YARN, { task: "show me how to X", record: true }), [
		"show me how to X",
		"Yarn",
		"--record",
	]);
});

test("buildRunArgs__OmitsTheTask__When__PassIsAGroundingRun", () => {
	assert.deepEqual(buildRunArgs(YARN), ["Yarn"]);
});

test("buildRunArgs__AppendsTheUrlFlag__When__TargetIsWeb", () => {
	const args = buildRunArgs(NOTION, { task: "change my timezone to Paris", record: true });
	assert.equal(args[0], "change my timezone to Paris");
	// The positional slot stays occupied: explore reads guidance from positional 1.
	assert.equal(args[1], "www.notion.so");
	assert.ok(args.includes("--url"));
	assert.equal(args[args.indexOf("--url") + 1], "https://www.notion.so/");
	assert.ok(args.includes("--record"));
});

test("buildRunArgs__RoundTripsThroughParseTarget__When__TargetIsWeb", () => {
	// The two halves of the seam must agree, or a dispatched run grounds a different target
	// than the one that was picked.
	const { target, rest } = parseTarget(buildRunArgs(NOTION, { task: "t" }), "Yarn");
	assert.equal(targetSlug(target), targetSlug(NOTION));
	assert.equal(rest[0], "t");
});

test("targetVocabulary__SaysMacosApp__When__TargetIsAnApp", () => {
	const v = targetVocabulary(YARN);
	assert.match(v.subject, /macOS app/);
	// An app target must carry no web cautions, or the prompt warns about a browser that isn't there.
	assert.equal(v.cautions, "");
});

test("targetVocabulary__WarnsAboutBrowserShortcuts__When__TargetIsWeb", () => {
	// cmd+w against a browser closes the tab and ends the run. Nothing else prevents this.
	const v = targetVocabulary(NOTION);
	assert.match(v.cautions, /cmd\+w/);
	assert.match(v.cautions, /URL/);
	assert.match(v.subject, /www\.notion\.so/);
});

test("targetVocabulary__NamesTheHostToStayOn__When__TargetIsWeb", () => {
	assert.match(targetVocabulary(NOTION).cautions, /Stay on www\.notion\.so/);
});

test("targetVocabulary__UsesAWebSurfaceTaxonomy__When__TargetIsWeb", () => {
	// The native taxonomy sends a web agent hunting for a menu bar that does not exist.
	const v = targetVocabulary(NOTION);
	assert.match(v.surfaces, /route/);
	assert.doesNotMatch(v.surfaces, /menu bar/);
});

test("buildRunArgs__CarriesEveryFlag__When__AllOptionsSet", () => {
	const args = buildRunArgs(NOTION, { task: "t", record: true, noVision: true, backend: "dom" });
	assert.ok(args.includes("--record"));
	assert.ok(args.includes("--no-vision"));
	assert.equal(args[args.indexOf("--backend") + 1], "dom");
});

test("isBrowserApp__Recognises__When__NameIsAKnownBrowser", () => {
	for (const n of ["Google Chrome", "Safari", "Firefox", "Microsoft Edge", "Arc", "Brave Browser"])
		assert.equal(isBrowserApp(n), true, n);
});

test("isBrowserApp__IsCaseInsensitive__When__NameIsOddlyCased", () => {
	assert.equal(isBrowserApp("  GOOGLE CHROME  "), true);
});

test("isBrowserApp__Recognises__When__NameIsAChannelBuild", () => {
	// Prefix match, so Dev/Beta channels come along without a table entry each.
	assert.equal(isBrowserApp("Google Chrome Beta"), true);
	assert.equal(isBrowserApp("Firefox Developer Edition"), true);
});

test("isBrowserApp__Rejects__When__NameMerelyStartsWithABrowserWord", () => {
	// "Operator" must not match "Opera", or selecting it would demand a URL it has no use for.
	assert.equal(isBrowserApp("Operator"), false);
	assert.equal(isBrowserApp("Safarinator"), false);
	assert.equal(isBrowserApp("Yarn"), false);
	assert.equal(isBrowserApp(""), false);
});
