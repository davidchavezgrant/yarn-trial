import assert from "node:assert/strict";
import { test } from "node:test";
import { pickWindow, type WindowCandidate } from "../src/core/harness.js";

// ---------------------------------------------------------------------------------------
// pickWindow: which window a run should be reading NOW. Fixture modeled on the live probe
// of 2026-07-31 (TextEdit, 22 windows) that diagnosed run 2026-07-31T10-29-05-036: the
// stale document and the real front window had IDENTICAL 603x505 bounds and both had
// titles, so the old findWindow sort (has-title, then area) could not distinguish them —
// the pick was input-order luck, and the run read the stale one for 11 straight steps.
// z_index is the front-order signal the old sort never consulted: the true front window
// carried 361, the stale one 344, and only the front one reported is_on_screen.
// ---------------------------------------------------------------------------------------

const win = (over: Partial<WindowCandidate>): WindowCandidate => ({
	app_name: "TextEdit",
	pid: 4242,
	window_id: 9000,
	title: "Untitled",
	is_on_screen: false,
	z_index: 100,
	bounds: { x: 120, y: 80, width: 603, height: 505 },
	...over,
});

/** The stale pinned document from the probe: titled, 603x505, z_index 344, not composited. */
const stale = win({ window_id: 9021, title: "Untitled 22.rtf", z_index: 344 });

/** The actual front window: same 603x505 bounds, z_index 361, the only composited one. */
const front = win({ window_id: 9137, title: "Untitled 23", z_index: 361, is_on_screen: true });

/** Junk placeholder rows the probe showed: untitled, 30-33px tall, parked offscreen, low z. */
const junk = [
	win({ window_id: 9001, title: "", z_index: 20, bounds: { x: -1200, y: 900, width: 603, height: 30 } }),
	win({ window_id: 9002, title: "", z_index: 21, bounds: { x: -1200, y: 940, width: 500, height: 33 } }),
];

test("PickWindow__PrefersFrontWindow__When__TitledCandidatesTieOnArea", () => {
	// The stale window comes FIRST so a sort that ties on (has-title, area) — the old
	// findWindow sort — deterministically picks it. Only the z-order/on-screen keys can
	// tell this pair apart; this is the exact pair the 0/11 run pinned wrongly.
	const picked = pickWindow([stale, ...junk, front], "TextEdit");
	assert.equal(picked?.window_id, front.window_id);
});

test("PickWindow__DropsOtherPidRows__When__PidIsGiven", () => {
	// Two instances can share an app_name; a follow must stay on the process we launched.
	// The impostor is strictly more attractive (on screen, higher z) and still loses.
	const impostor = win({ pid: 5555, window_id: 9500, title: "Other Instance", z_index: 400, is_on_screen: true });
	const picked = pickWindow([impostor, stale, front], "TextEdit", 4242);
	assert.equal(picked?.window_id, front.window_id);
});

test("PickWindow__NeverPicksUntitledJunk__When__ATitledWindowExists", () => {
	// The placeholder rows are 30-33px tall, so the tooltip/panel area guard drops them
	// before any sort key is consulted — even listed first and with a real window present.
	const picked = pickWindow([...junk, stale], "TextEdit");
	assert.equal(picked?.window_id, stale.window_id);
});

test("PickWindow__PrefersTitledWindow__When__OnScreenAndZIndexTie", () => {
	// An untitled window big enough to clear the area guard still loses to a titled peer
	// when the front-order keys cannot decide.
	const anon = win({ window_id: 9600, title: "", z_index: 344 });
	const picked = pickWindow([anon, stale], "TextEdit");
	assert.equal(picked?.window_id, stale.window_id);
});

test("PickWindow__PrefersOnScreenWindow__When__ZIndexFavorsTheOther", () => {
	// is_on_screen outranks z_index: only the composited window is what the screenshot
	// channel will actually capture. (It stays a sort PREFERENCE, not a filter — a
	// backgrounded-but-composited window can report false.)
	const composited = win({ window_id: 9700, title: "Visible", z_index: 300, is_on_screen: true });
	const buried = win({ window_id: 9701, title: "Buried", z_index: 400, is_on_screen: false });
	const picked = pickWindow([buried, composited], "TextEdit");
	assert.equal(picked?.window_id, composited.window_id);
});

test("PickWindow__ReturnsUndefined__When__NoCandidateSurvivesTheFilters", () => {
	assert.equal(pickWindow([], "TextEdit"), undefined);
	assert.equal(pickWindow([stale, front], "Preview"), undefined); // wrong app
	assert.equal(pickWindow(junk, "TextEdit"), undefined); // all junk — area guard drops every row
	assert.equal(pickWindow([stale, front], "TextEdit", 7777), undefined); // pid matches nothing
});
