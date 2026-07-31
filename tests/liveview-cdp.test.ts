import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cdpModifiers,
	cdpQuality,
	FollowStack,
	fractionToCss,
	type FrameMeta,
	homeTransitionGate,
	isIdlePage,
	keyEventParams,
	titleFor,
	mouseEventParams,
	sameEndpoint,
	wheelParams,
} from "../src/remote/liveview-cdp.js";

// ---- fractionToCss: viewer fractions onto the CURRENT viewport ---------------------------
// The CDP twin of the Swift engine's globalPoint: clamp first (authority clamp), then map
// against the latest frame's metadata. deviceWidth/deviceHeight are the viewport in CSS px,
// the exact space Input.dispatchMouseEvent speaks.

const META: FrameMeta = { deviceWidth: 1280, deviceHeight: 720 };

test("fractionToCss__MapsCentreToViewportCentre__When__FractionIsHalf", () => {
	assert.deepEqual(fractionToCss(0.5, 0.5, META), { x: 640, y: 360 });
});

test("fractionToCss__MapsCorners__When__FractionsAreZeroAndOne", () => {
	assert.deepEqual(fractionToCss(0, 0, META), { x: 0, y: 0 });
	assert.deepEqual(fractionToCss(1, 1, META), { x: 1280, y: 720 });
});

test("fractionToCss__Clamps__When__FractionLeavesTheImage", () => {
	// A drag that leaves the rendered image must not land somewhere else in the page.
	assert.deepEqual(fractionToCss(1.4, -0.2, META), { x: 1280, y: 0 });
});

test("fractionToCss__ReturnsZero__When__FractionIsNaN", () => {
	assert.deepEqual(fractionToCss(Number.NaN, Number.NaN, META), { x: 0, y: 0 });
});

test("fractionToCss__MapsAgainstPageSize__When__FrameWasDownscaled", () => {
	// maxWidth shrinks the JPEG, but metadata still reports the PAGE viewport — and since the
	// viewer speaks fractions of whatever it rendered, fraction × viewport stays correct at
	// any downscale. The mapping must not try to compensate.
	const downscaled: FrameMeta = { deviceWidth: 1600, deviceHeight: 900 };
	assert.deepEqual(fractionToCss(0.25, 0.5, downscaled), { x: 400, y: 450 });
});

// ---- cdpModifiers: CGEventFlags bitmask -> CDP modifiers bitmask -------------------------
// The viewer sends CGEventFlags (shift 0x20000, meta 0x100000, alt 0x80000, ctrl 0x40000);
// CDP wants Alt=1, Ctrl=2, Meta=4, Shift=8.

test("cdpModifiers__ReturnsZero__When__NoFlags", () => {
	assert.equal(cdpModifiers(0), 0);
});

test("cdpModifiers__MapsEachFlag__When__SentAlone", () => {
	assert.equal(cdpModifiers(0x80000), 1); // alt/option
	assert.equal(cdpModifiers(0x40000), 2); // ctrl
	assert.equal(cdpModifiers(0x100000), 4); // meta/cmd
	assert.equal(cdpModifiers(0x20000), 8); // shift
});

test("cdpModifiers__CombinesBits__When__SeveralFlagsHeld", () => {
	assert.equal(cdpModifiers(0x20000 | 0x100000), 8 | 4); // shift+cmd
	assert.equal(cdpModifiers(0x20000 | 0x100000 | 0x80000 | 0x40000), 15);
});

// ---- keyEventParams: the viewer's nine named CGKeyCodes -> DOM identity -------------------

test("keyEventParams__MapsEveryNamedCode__When__ViewerTableIsCovered", () => {
	// Exactly the NAMED table in liveview-viewer.ts — the only codes the viewer ever sends.
	const expected: Array<[number, string, string, number]> = [
		[36, "Enter", "Enter", 13],
		[48, "Tab", "Tab", 9],
		[51, "Backspace", "Backspace", 8],
		[53, "Escape", "Escape", 27],
		[49, " ", "Space", 32],
		[123, "ArrowLeft", "ArrowLeft", 37],
		[124, "ArrowRight", "ArrowRight", 39],
		[125, "ArrowDown", "ArrowDown", 40],
		[126, "ArrowUp", "ArrowUp", 38],
	];
	for (const [cg, key, code, vk] of expected) {
		const ev = keyEventParams(true, cg, 0);
		assert.ok(ev, `code ${cg} must translate`);
		assert.equal(ev!.key, key);
		assert.equal(ev!.code, code);
		assert.equal(ev!.windowsVirtualKeyCode, vk);
	}
});

test("keyEventParams__ReturnsUndefined__When__CodeIsOutsideTheTable", () => {
	// The viewer routes printables through `text` and never sends other codes; anything else
	// is dropped silently rather than guessed at.
	assert.equal(keyEventParams(true, 0, 0), undefined); // 'a' on ANSI
	assert.equal(keyEventParams(false, 999, 0), undefined);
});

test("keyEventParams__CarriesText__When__EnterOrSpaceGoesDown", () => {
	// Chromium synthesizes the char event from keyDown's `text` — without it, Enter never
	// submits a form. Only Enter and Space produce a character.
	const enter = keyEventParams(true, 36, 0)!;
	assert.equal(enter.type, "keyDown");
	assert.equal(enter.text, "\r");
	const space = keyEventParams(true, 49, 0)!;
	assert.equal(space.type, "keyDown");
	assert.equal(space.text, " ");
});

test("keyEventParams__SendsRawKeyDown__When__KeyProducesNoText", () => {
	const tab = keyEventParams(true, 48, 0)!;
	assert.equal(tab.type, "rawKeyDown");
	assert.equal(tab.text, undefined);
});

test("keyEventParams__SuppressesText__When__CommandIsHeld", () => {
	// cmd+Enter must not ALSO type a newline: a non-shift modifier strips the character,
	// mirroring Chromium's own keyboard rule.
	const ev = keyEventParams(true, 36, 0x100000)!;
	assert.equal(ev.type, "rawKeyDown");
	assert.equal(ev.text, undefined);
	assert.equal(ev.modifiers, 4);
});

test("keyEventParams__KeepsText__When__OnlyShiftIsHeld", () => {
	const ev = keyEventParams(true, 36, 0x20000)!;
	assert.equal(ev.type, "keyDown");
	assert.equal(ev.text, "\r");
	assert.equal(ev.modifiers, 8);
});

test("keyEventParams__SendsKeyUp__When__DownIsFalse", () => {
	const ev = keyEventParams(false, 53, 0)!;
	assert.equal(ev.type, "keyUp");
	assert.equal(ev.key, "Escape");
	assert.equal(ev.text, undefined);
});

test("keyEventParams__CarriesModifiers__When__FlagsSentWithNamedKey", () => {
	const ev = keyEventParams(true, 123, 0x20000 | 0x80000)!; // shift+option+left
	assert.equal(ev.modifiers, 8 | 1);
});

// ---- wheelParams: the double negation must cancel out -------------------------------------
// The viewer negates DOM wheel deltas into CGEvent convention; CDP speaks browser-native
// sign, so the engine negates BACK. A scroll-down gesture (DOM deltaY>0) must arrive at
// Chromium as deltaY>0 again.

test("wheelParams__RestoresBrowserSign__When__ViewerNegatedForCGEvent", () => {
	// Operator scrolls down: DOM deltaY=+120, viewer sends dy=-120, CDP must get deltaY=+120.
	const ev = wheelParams({ cmd: "scroll", x: 0.5, y: 0.5, dy: -120, dx: -6 }, META);
	assert.equal(ev.type, "mouseWheel");
	assert.equal(ev.deltaY, 120);
	assert.equal(ev.deltaX, 6);
});

test("wheelParams__MapsPositionThroughFractions__When__ScrollCarriesCoordinates", () => {
	const ev = wheelParams({ cmd: "scroll", x: 0.25, y: 1, dy: 3, dx: 2 }, META);
	assert.equal(ev.x, 320);
	assert.equal(ev.y, 720);
	assert.equal(ev.deltaY, -3);
	assert.equal(ev.deltaX, -2);
});

// ---- mouseEventParams: command -> CDP params, buttons mask threaded across commands -------
// `buttons` is what makes a drag a drag: the mask must reflect what is held ACROSS down/
// move/up, and per DOM convention the released button is already absent from mouseReleased.

test("mouseEventParams__PressesWithButtonsSet__When__LeftDown", () => {
	const t = mouseEventParams({ cmd: "mouse", type: "down", x: 0.5, y: 0.5, button: "left" }, META, 0);
	assert.equal(t.held, 1);
	assert.equal(t.events.length, 1);
	const ev = t.events[0];
	assert.equal(ev.type, "mousePressed");
	assert.equal(ev.button, "left");
	assert.equal(ev.buttons, 1);
	assert.equal(ev.clickCount, 1);
	assert.equal(ev.x, 640);
	assert.equal(ev.y, 360);
});

test("mouseEventParams__CarriesHeldMask__When__MoveHappensMidDrag", () => {
	const t = mouseEventParams({ cmd: "mouse", type: "move", x: 0.6, y: 0.4, button: "left" }, META, 1);
	assert.equal(t.held, 1);
	const ev = t.events[0];
	assert.equal(ev.type, "mouseMoved");
	assert.equal(ev.buttons, 1);
	assert.equal(ev.button, "left");
});

test("mouseEventParams__ReportsNoButton__When__MoveWithNothingHeld", () => {
	const t = mouseEventParams({ cmd: "mouse", type: "move", x: 0.1, y: 0.1, button: "left" }, META, 0);
	const ev = t.events[0];
	assert.equal(ev.button, "none");
	assert.equal(ev.buttons, 0);
});

test("mouseEventParams__ClearsButtonFromMask__When__Released", () => {
	const t = mouseEventParams({ cmd: "mouse", type: "up", x: 0.5, y: 0.5, button: "left" }, META, 1);
	assert.equal(t.held, 0);
	const ev = t.events[0];
	assert.equal(ev.type, "mouseReleased");
	// DOM convention: the released button is absent from mouseReleased's own mask.
	assert.equal(ev.buttons, 0);
	assert.equal(ev.button, "left");
});

test("mouseEventParams__TracksRightButton__When__RightDownDuringLeftHold", () => {
	const down = mouseEventParams({ cmd: "mouse", type: "down", x: 0, y: 0, button: "right" }, META, 1);
	assert.equal(down.held, 3); // left(1) | right(2)
	assert.equal(down.events[0].buttons, 3);
	const up = mouseEventParams({ cmd: "mouse", type: "up", x: 0, y: 0, button: "right" }, META, down.held);
	assert.equal(up.held, 1); // left survives
	assert.equal(up.events[0].buttons, 1);
});

test("mouseEventParams__EmitsFullCycle__When__ClickArrives", () => {
	// The viewer never sends "click" (it speaks down/up pairs), but a hand-rolled client
	// might — accepted as one press-release cycle that leaves the mask where it started.
	const t = mouseEventParams({ cmd: "mouse", type: "click", x: 0.5, y: 0.5, button: "left" }, META, 0);
	assert.equal(t.held, 0);
	assert.deepEqual(t.events.map((e) => e.type), ["mousePressed", "mouseReleased"]);
	assert.equal(t.events[0].buttons, 1);
	assert.equal(t.events[1].buttons, 0);
});

test("mouseEventParams__ClampsCoordinates__When__FractionLeavesTheImage", () => {
	const t = mouseEventParams({ cmd: "mouse", type: "down", x: 1.9, y: -0.5, button: "left" }, META, 0);
	assert.equal(t.events[0].x, 1280);
	assert.equal(t.events[0].y, 0);
});

// ---- cdpQuality: one ServerOptions.quality, two engines, two unit conventions -------------
// The SCK engine takes 0..1 (default 0.78); CDP takes 0..100. A fraction scales up, a
// percent clamps, unset gets a sane default.

test("cdpQuality__ScalesToPercent__When__GivenSckStyleFraction", () => {
	assert.equal(cdpQuality(0.4), 40);
	assert.equal(cdpQuality(0.78), 78);
	assert.equal(cdpQuality(1), 100); // reads as the fraction, not 1%
});

test("cdpQuality__PassesThrough__When__AlreadyAPercent", () => {
	assert.equal(cdpQuality(60), 60);
	assert.equal(cdpQuality(250), 100); // clamped
});

test("cdpQuality__ReturnsDefault__When__UnsetOrUnusable", () => {
	assert.equal(cdpQuality(undefined), 80);
	assert.equal(cdpQuality(0), 80);
	assert.equal(cdpQuality(Number.NaN), 80);
});

// ---- homeTransitionGate: "signed in" means the home label RETURNED, not that it is there ----
// The false-fire this guards against was live on all three Macs, 2026-07-31: the runner's
// signin verb restores the operator's parked profile and launches the app, which boots into a
// CACHED render of the signed-in Library before its dead token redirects it to /login. A level
// check ("is 'Library' on screen?") caught that flash on the first poll and closed every
// sign-in session ~3.5s in — the operator could no longer sign in at all.

const APP = "https://y-prod-react.onrender.com/login";
const HOME = "https://y-prod-react.onrender.com/library/ag";

test("homeTransitionGate__DoesNotFire__When__TheLabelIsAlreadyVisibleOnTheFirstPoll", () => {
	// The cached-Library flash at app launch: visible from tick one is the baseline, not a win.
	const fire = homeTransitionGate(APP);
	assert.equal(fire(HOME, "Library"), false);
});

test("homeTransitionGate__Fires__When__TheLabelAppearsAfterBeingAbsent", () => {
	// The real sign-in: /login (absent) → OAuth → the app lands on its home route.
	const fire = homeTransitionGate(APP);
	assert.equal(fire(APP, undefined), false);
	assert.equal(fire(HOME, "Library"), true);
});

test("homeTransitionGate__DoesNotFire__When__TheLabelAppearsOnAForeignOrigin", () => {
	// Yarn's "Continue with Google" navigates the PRIMARY window to accounts.google.com, so
	// "primary-page-only" does not keep the watch off the provider's pages — the origin must.
	const fire = homeTransitionGate(APP);
	assert.equal(fire(APP, undefined), false);
	assert.equal(fire("https://accounts.google.com/v3/signin/identifier", "Library"), false);
});

test("homeTransitionGate__TreatsAForeignOriginAsAbsence__When__TheFlowDetoursThroughOAuth", () => {
	// Flash → OAuth in the same window → home. The detour IS the going-away; the return fires.
	const fire = homeTransitionGate(APP);
	assert.equal(fire(HOME, "Library"), false);
	assert.equal(fire("https://accounts.google.com/signin/challenge", "Library"), false);
	assert.equal(fire(HOME, "Library"), true);
});

test("homeTransitionGate__NeverFires__When__TheSessionStartUrlIsUnparseable", () => {
	// A session anchored to about:blank (app still booting) has no origin to trust — the watch
	// stays off and the session keeps its pre-auto-close behaviour rather than guessing.
	const fire = homeTransitionGate("about:blank");
	assert.equal(fire(HOME, undefined), false);
	assert.equal(fire(HOME, "Library"), false);
});

// ---- FollowStack: newest page wins, pop on close -------------------------------------------
// The endpoint-hopping policy, pure. A sign-in flow is a stack of detours (app page → OAuth
// popup → consent page); the human always works the most recently opened one, and a closing
// page returns the stream to wherever the flow came from. Pages are plain strings here — the
// policy must be testable without playwright.

test("FollowStack__MakesNewestPageActive__When__Pushed", () => {
	const s = new FollowStack<string>();
	s.push("app", "primary");
	assert.deepEqual(s.active, { page: "app", origin: "primary" });
	s.push("oauth", "browser");
	assert.deepEqual(s.active, { page: "oauth", origin: "browser" });
	assert.equal(s.size, 2);
});

test("FollowStack__PopsToPreviousLivePage__When__ActivePageCloses", () => {
	// The deep-link return: the OAuth page closing IS the way back to the app page.
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.push("oauth", "browser");
	s.dropClosed("oauth");
	assert.deepEqual(s.active, { page: "app", origin: "primary" });
	assert.equal(s.size, 1);
});

test("FollowStack__RemovesSilently__When__NonActivePageCloses", () => {
	// The page UNDER the detour going away must not disturb what is streaming.
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.push("oauth", "browser");
	s.dropClosed("app");
	assert.deepEqual(s.active, { page: "oauth", origin: "browser" });
	assert.equal(s.size, 1);
});

test("FollowStack__GoesEmpty__When__LastPageCloses", () => {
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.dropClosed("app");
	assert.equal(s.active, undefined);
	assert.equal(s.size, 0);
});

test("FollowStack__Ignores__When__UnknownPageCloses", () => {
	// Close events arrive for pages the engine chose never to follow (devtools, filtered).
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.dropClosed("devtools");
	assert.deepEqual(s.active, { page: "app", origin: "primary" });
	assert.equal(s.size, 1);
});

test("FollowStack__MovesToTopWithoutDuplicating__When__PagePushedTwice", () => {
	// A re-push must not leave a second entry behind: its close must pop exactly once.
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.push("tab", "browser");
	s.push("app", "primary");
	assert.equal(s.size, 2);
	assert.deepEqual(s.active, { page: "app", origin: "primary" });
	s.dropClosed("app");
	assert.deepEqual(s.active, { page: "tab", origin: "browser" });
	assert.equal(s.size, 1);
});

test("FollowStack__DropsEveryBrowserPage__When__BrowserOriginDies", () => {
	// The secondary endpoint dying takes all its pages at once — their individual close
	// events never crossed the dead connection — and the stream falls back to the app.
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.push("oauth", "browser");
	s.push("consent", "browser");
	s.dropOrigin("browser");
	assert.deepEqual(s.active, { page: "app", origin: "primary" });
	assert.equal(s.size, 1);
});

test("FollowStack__KeepsActive__When__DeadOriginContributedNothing", () => {
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.dropOrigin("browser");
	assert.deepEqual(s.active, { page: "app", origin: "primary" });
	assert.equal(s.size, 1);
});

test("FollowStack__DropsOnlyPrimaryPages__When__PrimaryOriginNamed", () => {
	// The primary-vs-secondary death distinction lives in the ENGINE (primary death fires
	// onExit; the browser leg dying only pops) — the drop itself is symmetric and must not
	// touch the other origin's pages.
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.push("oauth", "browser");
	s.dropOrigin("primary");
	assert.deepEqual(s.active, { page: "oauth", origin: "browser" });
	assert.equal(s.size, 1);
});

// ---- the title bar shows a title, not a 1500-character OAuth URL -------------------------

test("titleFor__KeepsARealTitle__When__ThePageHasOne", () => {
	assert.equal(titleFor("Sign in - Google Accounts"), "Sign in - Google Accounts");
});

test("titleFor__ShortensToOriginAndPath__When__TheFallbackIsAUrl", () => {
	// Live on mac3, 2026-07-31: Google's consent URL is ~1500 chars of query string, and the
	// viewer rendered every one of them — six wrapped lines that pushed the canvas off screen.
	const oauth = "https://accounts.google.com/v3/signin/identifier?opparams=%253F&dsh=S-1037491303" + "&x=".repeat(400);
	const out = titleFor(oauth);

	assert.ok(out.length <= 80, `got ${out.length} chars`);
	assert.match(out, /^accounts\.google\.com\/v3\/signin\/identifier/);
	assert.equal(out.includes("?"), false, "the query string is the part that made it enormous");
});

test("titleFor__DropsTheBareSlash__When__TheUrlHasNoPath", () => {
	assert.equal(titleFor("https://example.com/"), "example.com");
});

test("titleFor__StillTruncates__When__ATitleIsLongWithoutBeingAUrl", () => {
	assert.equal(titleFor("x".repeat(200)).length, 80);
});

// ---- idle pages rank below live ones, so an empty tab cannot take the stream -------------

test("FollowStack__KeepsTheLivePageActive__When__AnIdleTabArrivesLater", () => {
	// mac3, 2026-07-31, a regression from the adoption fix: the lazily-attached OAuth Chrome
	// contributed its New Tab, which arrived AFTER Yarn's login page and won newest-wins. The
	// operator opened the viewer onto an empty tab with the sign-in hidden behind it.
	const s = new FollowStack<string>();
	s.push("yarn-login", "primary");
	s.push("chrome-newtab", "browser", true);

	assert.equal(s.active?.page, "yarn-login");
});

test("FollowStack__StillReachesTheIdlePage__When__Cycled", () => {
	// Ranked, not filtered: a flow can legitimately sit on about:blank mid-redirect, so the
	// operator must still be able to get there.
	const s = new FollowStack<string>();
	s.push("yarn-login", "primary");
	s.push("chrome-newtab", "browser", true);
	s.cycle();

	assert.equal(s.active?.page, "chrome-newtab");
});

test("isIdlePage__NamesOnlyLandingSurfaces__When__GivenBrowserUrls", () => {
	for (const u of ["", "about:blank", "chrome://newtab/", "chrome://new-tab-page/"]) assert.equal(isIdlePage(u), true, u);
	// The interstitial that blocked the mac3 sign-in is a chrome:// page and must NEVER be
	// ranked idle — treating the whole scheme as idle would hide the pages that matter most.
	for (const u of ["chrome://managed-user-profile-notice/", "https://accounts.google.com/", "https://y-prod-react.onrender.com/login"])
		assert.equal(isIdlePage(u), false, u);
});

// ---- cycle: the operator's override for a newest-wins pick that landed wrong -------------

test("FollowStack__MakesAnotherPageActive__When__Cycled", () => {
	// The mac3 case, 2026-07-31: a blocking `chrome://managed-user-profile-notice` was pushed,
	// then the SetSID redirect page opened after it and won. The human needs the interstitial.
	const s = new FollowStack<string>();
	s.push("notice", "browser");
	s.push("redirect", "browser");
	assert.equal(s.active?.page, "redirect");

	s.cycle();

	assert.equal(s.active?.page, "notice");
});

test("FollowStack__ReachesEveryPageAndReturns__When__CycledRepeatedly", () => {
	// Rotation, not a swap: a swap can never reach the middle of three, so an operator would
	// have a page they cannot get to. Cycling the full length must come back to the start.
	const s = new FollowStack<string>();
	for (const p of ["a", "b", "c"]) s.push(p, "primary");
	const seen = [s.active?.page];
	for (let i = 0; i < 3; i++) {
		s.cycle();
		seen.push(s.active?.page);
	}

	// Oldest-to-top, so the walk runs a→b→c rather than backwards. Either direction is fine;
	// what matters is that all three are reachable and the fourth press is home again.
	assert.deepEqual(seen, ["c", "a", "b", "c"], "every page reachable, and back where it started");
});

test("FollowStack__StaysEmpty__When__CycledWithNothingFollowed", () => {
	const s = new FollowStack<string>();
	s.cycle();

	assert.equal(s.active, undefined);
	assert.equal(s.size, 0);
});

test("FollowStack__RevivesWithNewPage__When__PushedAfterEmptying", () => {
	// An emptied stack is not a dead session (only primary-endpoint death is): a page
	// opening later streams again.
	const s = new FollowStack<string>();
	s.push("app", "primary");
	s.dropClosed("app");
	s.push("fresh", "primary");
	assert.deepEqual(s.active, { page: "fresh", origin: "primary" });
	assert.equal(s.size, 1);
});

// ---- sameEndpoint: attach once when both endpoints name one Chrome -------------------------
// Two connections to the same Chrome would follow every page twice.

test("sameEndpoint__MatchesByOrigin__When__OnlyTrailingSlashDiffers", () => {
	assert.equal(sameEndpoint("http://127.0.0.1:9222", "http://127.0.0.1:9222/"), true);
});

test("sameEndpoint__Differs__When__PortsDiffer", () => {
	// The default split: 9222 (app/Electron convention) vs 9777 (the cdp backend's Chrome).
	assert.equal(sameEndpoint("http://127.0.0.1:9222", "http://127.0.0.1:9777"), false);
});

test("sameEndpoint__FallsBackToLiteralEquality__When__Unparseable", () => {
	assert.equal(sameEndpoint("not a url", "not a url"), true);
	assert.equal(sameEndpoint("not a url", "http://127.0.0.1:9222"), false);
});
