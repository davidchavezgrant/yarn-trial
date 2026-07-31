import assert from "node:assert/strict";
import { test } from "node:test";
import { type Boundary, boundaryDescription, classifyBoundary, newElements } from "./boundary.js";
import type { InteractiveElement, ObservationBundle } from "./harness.js";

/**
 * The classifier decides what an exploration pass RECORDS after pressing a destructive
 * control, and both directions of error are costly: a confirmation read as no-modal flags a
 * phantom commit for cleanup, and a silent commit read as a dialog records a gate that was
 * never actually there. Every heuristic branch gets a fixture, including the Electron shape
 * (plain AXGroups, no dialog role) the roles-based reading would miss entirely.
 */

const ie = (name: string, surface = "", box: Partial<InteractiveElement> = {}): InteractiveElement =>
	({ handle: 0, role: "AXButton", name, surface, value: "", x: 0, y: 0, w: 0, h: 0, ...box });

/**
 * Approximates how observe() in src/harness.ts builds the haystack: the window title, then
 * every element label and value on its own line, all lowercased. `extraHaystack` stands in
 * for AXStaticText — dialog body copy that reaches the haystack but never `interactive`.
 */
const obsWith = (interactive: InteractiveElement[], extraHaystack: string[] = [], title = "Yarn", url?: string): ObservationBundle => ({
	elementsText: "",
	haystack: [title, ...interactive.flatMap((e) => [e.name, e.value]).filter((t) => t !== ""), ...extraHaystack]
		.join("\n")
		.toLowerCase(),
	screenshotB64: "",
	title,
	url,
	interactive,
	appContent: interactive.length,
	domEnriched: 0,
	frames: new Map(),
});

// --- newElements ---

test("newElements__ReturnsOnlyFreshPairs__When__NextAddsAnElement", () => {
	const prev = obsWith([ie("Delete draft", "Draft menu", { handle: 3 })]);
	const next = obsWith([ie("Delete draft", "Draft menu", { handle: 41 }), ie("Cancel", "Confirm dialog", { handle: 42 })]);
	const fresh = newElements(prev, next);
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].name, "Cancel");
});

test("newElements__ReturnsEmpty__When__OnlyHandlesChanged", () => {
	const prev = obsWith([ie("Save", "Toolbar", { handle: 3 }), ie("Undo", "Toolbar", { handle: 5 })]);
	const next = obsWith([ie("Save", "Toolbar", { handle: 9 }), ie("Undo", "Toolbar", { handle: 1 })]);
	assert.deepEqual(newElements(prev, next), []);
});

test("newElements__SkipsElement__When__NameAndSurfaceBothEmpty", () => {
	const prev = obsWith([ie("Save", "Toolbar")]);
	const next = obsWith([ie("Save", "Toolbar"), ie("", "", { handle: 7 })]);
	assert.deepEqual(newElements(prev, next), []);
});

test("newElements__ReturnsEmpty__When__ObservationsIdentical", () => {
	const els = [ie("Save", "Toolbar"), ie("Cursor Style", "Settings", { role: "AXPopUpButton", value: "Arrow" })];
	assert.deepEqual(newElements(obsWith(els), obsWith(els)), []);
});

// --- classifyBoundary: confirm-dialog ---

test("classifyBoundary__ReturnsConfirmDialog__When__DangerCopyInFreshElementValue", () => {
	const prev = obsWith([ie("Delete draft", "Draft menu")]);
	const next = obsWith([
		ie("Delete draft", "Draft menu"),
		ie("", "Delete confirmation", { role: "AXGroup", value: "This action cannot be undone." }),
	]);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "confirm-dialog");
	assert.match(b.detail, /cannot be undone/i);
});

test("classifyBoundary__ReturnsConfirmDialog__When__FreshCancelCommitPairWithNoRoleAndNoCopy", () => {
	// The Electron shape: the modal is plain divs, no AXDialog/AXSheet anywhere, and the
	// body text uses wording outside the danger regex. The button pair alone must carry it.
	const prev = obsWith([ie("Delete draft", "Draft menu")]);
	const next = obsWith([
		ie("Delete draft", "Draft menu"),
		ie("Keep draft", "modal"),
		ie("Delete", "modal"),
	]);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "confirm-dialog");
	assert.match(b.detail, /button pair/);
	assert.match(b.detail, /Keep draft/);
});

test("classifyBoundary__ReturnsConfirmDialog__When__DangerCopyOnlyInHaystackDelta", () => {
	// Dialog body copy lives in AXStaticText, which never reaches `interactive` — the
	// haystack line diff is the only channel that sees it.
	const prev = obsWith([ie("Remove project", "Project menu")]);
	const next = obsWith(
		[ie("Remove project", "Project menu"), ie("Got it", "confirm")],
		["The project will be removed from all devices."],
	);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "confirm-dialog");
	assert.match(b.detail, /will be removed/i);
});

test("classifyBoundary__ReturnsConfirmDialog__When__MenuItemsNamedDeleteAreNotButtons", () => {
	// A context menu opening exposes fresh AXMenuItems named "Delete" and "Cancel"-adjacent
	// labels; a menu is not a confirmation, so the pair heuristic must read buttons only.
	const prev = obsWith([ie("Draft 3", "Drafts", { role: "AXLink" })]);
	const next = obsWith([
		ie("Draft 3", "Drafts", { role: "AXLink" }),
		ie("Delete", "Draft context menu", { role: "AXMenuItem" }),
		ie("Keep in library", "Draft context menu", { role: "AXMenuItem" }),
	]);
	assert.equal(classifyBoundary(prev, next).kind, "no-modal");
});

// --- classifyBoundary: file-sheet ---

test("classifyBoundary__ReturnsFileSheet__When__AXSheetRoleWithFileVocabulary", () => {
	const prev = obsWith([ie("Export", "Toolbar")]);
	const next = obsWith([
		ie("Export", "Toolbar"),
		ie("Save dialog", "", { role: "AXSheet" }),
		ie("Where", "Save dialog", { role: "AXPopUpButton", value: "Documents" }),
	]);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "file-sheet");
	assert.match(b.detail, /^native file sheet: /);
	assert.match(b.detail, /Where/);
});

test("classifyBoundary__ReturnsFileSheet__When__SaveAsWhereClusterWithSaveCancelPair", () => {
	// No AXSheet role at all — an Electron-drawn save surface is recognized by its
	// vocabulary plus the Save/Cancel pair.
	const prev = obsWith([ie("Export", "Toolbar")]);
	const next = obsWith([
		ie("Export", "Toolbar"),
		ie("Save As", "export panel", { role: "AXTextField", value: "untitled" }),
		ie("Where", "export panel", { role: "AXPopUpButton", value: "Desktop" }),
		ie("Save", "export panel"),
		ie("Cancel", "export panel"),
	]);
	assert.equal(classifyBoundary(prev, next).kind, "file-sheet");
});

// --- classifyBoundary: oauth-window ---

test("classifyBoundary__ReturnsOauthWindow__When__NextUrlIsGoogleAccounts", () => {
	const prev = obsWith([ie("Sign in", "Settings")]);
	const next = obsWith([ie("Continue", "consent")], [], "Sign in - Google Accounts", "https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "oauth-window");
	assert.match(b.detail, /accounts\.google\.com/);
});

test("classifyBoundary__ReturnsOauthWindow__When__AuthUrlSurfacesInFreshElementValue", () => {
	// The axdom sidecar surfaces AXURL into values on Electron, so the auth host can arrive
	// with no next.url at all.
	const prev = obsWith([ie("Connect account", "Integrations")]);
	const next = obsWith([
		ie("Connect account", "Integrations"),
		ie("Continue with Microsoft", "auth window", { role: "AXLink", value: "https://login.microsoftonline.com/common/oauth2/authorize" }),
	]);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "oauth-window");
	assert.match(b.detail, /login\.microsoftonline/);
});

test("classifyBoundary__ReturnsOauthWindow__When__ConfirmDialogSignatureAlsoPresent", () => {
	// Order pin: an OAuth consent page is full of Cancel/Continue buttons and would satisfy
	// the confirm-dialog pair heuristic. The more specific signature must win.
	const prev = obsWith([ie("Sign in", "Settings")]);
	const next = obsWith(
		[ie("Cancel", "consent"), ie("Confirm", "consent")],
		["this will delete your other session"],
		"Consent",
		"https://accounts.google.com/signin/oauth/consent",
	);
	assert.equal(classifyBoundary(prev, next).kind, "oauth-window");
});

// --- classifyBoundary: no-modal ---

test("classifyBoundary__ReturnsNoModal__When__NextOnlyReshufflesHandles", () => {
	const prev = obsWith([ie("Delete draft", "Draft menu", { handle: 3 }), ie("Save", "Toolbar", { handle: 4 })]);
	const next = obsWith([ie("Delete draft", "Draft menu", { handle: 12 }), ie("Save", "Toolbar", { handle: 2 })]);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "no-modal");
	assert.match(b.detail, /no new elements/);
	assert.deepEqual(b.controls, []);
});

test("classifyBoundary__ReturnsNoModal__When__FreshElementsCarryNoSignature", () => {
	// A tooltip appeared: fresh, named, and meaningless as a boundary.
	const prev = obsWith([ie("Delete draft", "Draft menu")]);
	const next = obsWith([ie("Delete draft", "Draft menu"), ie("Bold (⌘B)", "tooltip", { role: "AXStaticText" })]);
	const b = classifyBoundary(prev, next);
	assert.equal(b.kind, "no-modal");
	assert.match(b.detail, /no dialog signature/);
	assert.equal(b.controls.length, 1);
});

// --- boundaryDescription ---

test("boundaryDescription__IncludesKindAndDetail__When__Rendering", () => {
	const b: Boundary = { kind: "file-sheet", detail: "native file sheet: Where", controls: [ie("Where", "sheet")] };
	const line = boundaryDescription(b);
	assert.match(line, /^file-sheet: native file sheet: Where/);
	assert.match(line, /options: Where/);
});

test("boundaryDescription__CapsOptionList__When__ControlsExceedTwelve", () => {
	const controls = Array.from({ length: 20 }, (_, i) => ie(`Option ${i + 1}`, "consent"));
	const line = boundaryDescription({ kind: "oauth-window", detail: "accounts.google.com", controls });
	assert.match(line, /\+8 more/);
	assert.ok(line.includes("Option 12"));
	assert.ok(!line.includes("Option 13"));
});

test("boundaryDescription__DedupesOptionNames__When__ControlsRepeat", () => {
	const b: Boundary = {
		kind: "confirm-dialog",
		detail: '"are you sure?"',
		controls: [ie("Cancel", "modal"), ie("Cancel", "modal footer"), ie("Delete", "modal")],
	};
	const line = boundaryDescription(b);
	assert.equal(line.match(/Cancel/g)?.length, 1);
});
