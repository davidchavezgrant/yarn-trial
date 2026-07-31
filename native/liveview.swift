// liveview — stream one window's pixels and inject input into it, for a human-driven,
// window-scoped remote login.
//
// WHY THIS EXISTS. The rest of the repo signs an app in over full-desktop VNC (see
// src/remote/signin.ts). That works but streams the whole console — every other window on a
// shared fleet Mac travels the wire — and it needs a VNC client. This is the window-scoped
// alternative: the teammate opens a URL in their own browser, sees ONLY the app they are
// signing into, drives it, and closes the tab. Two properties fall out of capturing a single
// window natively rather than cropping a desktop stream:
//
//   - Grade 2 (capture isolation): only the tracked window's pixels are ever encoded, so
//     nothing else on that Mac's desktop can leak into the stream or a screenshot of it.
//   - Grade 1 (focus): the viewer shows just that window, no desktop to navigate.
//
// One mechanism, both goals — which is why the SCK path is primary and the desktop-crop path
// (handled in TypeScript) is only a fallback for the moments SCK cannot isolate a window.
//
// WHY "FOLLOW THE KEY WINDOW" AND NOT "PIN A WINDOW". A login is exactly the flow that hands
// off between windows: "Sign in with Google" launches a browser (or, on native apps, an
// ASWebAuthenticationSession agent in a SEPARATE process), the human logs in there, focus
// returns to the app. A stream pinned to the app's window by pid would freeze on the app while
// the real login happens in an invisible one. So the default is to track whatever window is
// frontmost, which follows that handoff with no per-app knowledge — the browser becomes
// frontmost, the stream follows; focus returns, it follows back. The caller can still `pin` a
// specific window id when it wants to defeat that (e.g. to refuse to ever show the desktop).
//
// WHY A NATIVE SIDECAR (same reasoning as native/axdom.swift). Single-window capture and
// synthetic input live behind ScreenCaptureKit and the CoreGraphics event C APIs, which Node
// cannot call. Swift needs CLT only to BUILD; the compiled binary runs on any Mac. Running it
// as a child process buys hang isolation the same way axdom does.
//
// PERMISSIONS. Capture needs the Screen Recording grant; input injection needs Accessibility.
// The fleet Macs already hold both (the runner is the Electron process precisely so it does —
// see src/remote/provision.ts). A missing grant is reported on stderr as a typed line, never a
// crash, so the TypeScript side can tell the operator which grant to add.
//
// PROTOCOL. Commands arrive as one JSON object per line on stdin; frames and events leave as
// framed output on a dedicated fd (see below). Everything is line- or length-delimited so the
// Node parent never has to guess boundaries.
//
//   stdin  (JSONL commands):
//     {"cmd":"follow"}                     track the frontmost on-screen window (default)
//     {"cmd":"pin","window":<id>}          track exactly this CGWindowID, never switch
//     {"cmd":"mouse","type":"move|down|up|click","x":<f>,"y":<f>,"button":"left|right"}
//     {"cmd":"scroll","x":<f>,"y":<f>,"dy":<i>,"dx":<i>}
//     {"cmd":"key","down":<bool>,"code":<i>,"flags":<i>}     // CGKeyCode + CGEventFlags
//     {"cmd":"text","s":"..."}             // type a unicode string (for pasted values)
//     {"cmd":"quit"}
//     x/y are 0..1 fractions of the tracked window, so the viewer never needs to know pixels;
//     the engine clamps them, so out-of-range input cannot reach past the window.
//
//   fd 3   (binary frames): each frame is  "F" <uint32 length BE> <jpeg bytes>.
//   stdout (JSONL events):  {"ev":"window","id":..,"title":..,"app":..,"x":..,"y":..,"w":..,"h":..,"scale":..,
//                            "foreign":<bool>,"crop":{"x":..,"y":..,"w":..,"h":..}?}
//                           {"ev":"auto","pressed":"Open Yarn.app"}
//                           {"ev":"blocked","what":"key","code":<i>}
//                           {"ev":"error","kind":"no-screen-recording|no-window|..","detail":".."}
//
// CONSTRAINED BROWSER MODE (--app / LIVEVIEW_APP). A sign-in hands off to an external browser,
// and streaming that browser whole hands the operator its URL bar — visually (they see the
// address) and operationally (a click, or Cmd+L, reaches it and can navigate the Mac anywhere).
// When the target app is named and the followed window belongs to a DIFFERENT app, the engine:
//   - crops frames to the window's AXWebArea (the page content below the toolbar), which both
//     fills the viewer with the login form and removes the browser chrome from the stream;
//   - remaps incoming fractions onto that crop, so clicks cannot land on the toolbar at all;
//   - drops Cmd-modified keys except A/C/V/X/Z (paste must survive — passwords and 2FA codes
//     arrive by paste), so Cmd+L/T/N cannot reach the chrome either;
//   - watches for the external-protocol confirmation ("Open <App>.app") and presses it, so the
//     redirect back to the app is hands-free.
// The trade, stated plainly: hiding the URL bar removes the operator's ability to eyeball the
// page origin. Over a JPEG stream that was weak verification anyway; trust is anchored in the
// runner having launched the flow on a machine we control. The target app's own window is
// never cropped or filtered. Without --app, nothing changes.
//
// Usage: liveview [--fps N] [--quality Q] [--max-width W] [--app "Name"]
//
// Durable exit: this is trial tooling. If Yarn ships its own capture pipeline, this is deleted.
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import VideoToolbox

// ---- args -------------------------------------------------------------------------------

// Encode ceilings sized for legible TEXT, which is what a login form is: 1280px across a
// retina window halved every glyph, and q0.6 put JPEG ringing exactly where the characters
// are. The server already drops frames under backpressure, so a slow tunnel costs fps — the
// degradation that does not matter for a form — never sharpness.
var fps = 15
var quality: Float = 0.78
var maxWidth = 1920
// The sign-in target. Env first (the runner passes LIVEVIEW_APP through the CLI), argv wins.
// Empty means no constrained mode — plain window streaming, exactly as before.
var targetApp = ProcessInfo.processInfo.environment["LIVEVIEW_APP"] ?? ""
do {
	var it = CommandLine.arguments.dropFirst().makeIterator()
	while let a = it.next() {
		switch a {
			case "--fps": if let v = it.next(), let n = Int(v) { fps = max(1, min(60, n)) }
			case "--quality": if let v = it.next(), let q = Float(v) { quality = max(0.1, min(1.0, q)) }
			case "--max-width": if let v = it.next(), let w = Int(v) { maxWidth = max(320, w) }
			case "--app": if let v = it.next() { targetApp = v }
			default: break
		}
	}
}

// "Yarn", "Yarn.app" and "yarn" are the same app. Everything that compares app names goes
// through this, so the follow decision and the button match cannot disagree.
func normalizedAppName(_ s: String) -> String {
	var n = s.trimmingCharacters(in: .whitespaces).lowercased()
	if n.hasSuffix(".app") { n = String(n.dropLast(4)) }
	return n
}

func isForeign(app: String) -> Bool {
	!targetApp.isEmpty && normalizedAppName(app) != normalizedAppName(targetApp)
}

// ---- typed stderr/stdout so the parent can react rather than parse prose -----------------

let errOut = FileHandle.standardError
let evOut = FileHandle.standardOutput
// fd 3 is opened by the parent for binary frames. Run by hand there is no fd 3, and the first
// frame write would kill the process before any typed event could explain why — so probe with
// fcntl (F_GETFD is side-effect-free; -1/EBADF means nothing is open there) and fall back to
// the null device: a manual smoke test still gets events on stdout, the frames just go nowhere.
let frameFd: FileHandle = fcntl(3, F_GETFD) != -1
	? FileHandle(fileDescriptor: 3, closeOnDealloc: false)
	: FileHandle.nullDevice

func emitEvent(_ obj: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: obj),
	      var line = String(data: data, encoding: .utf8) else { return }
	line += "\n"
	evOut.write(line.data(using: .utf8)!)
}

func emitError(_ kind: String, _ detail: String) {
	emitEvent(["ev": "error", "kind": kind, "detail": detail])
}

func emitFrame(_ jpeg: Data) {
	var header = Data([0x46]) // 'F'
	var len = UInt32(jpeg.count).bigEndian
	withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }
	do {
		try frameFd.write(contentsOf: header)
		try frameFd.write(contentsOf: jpeg)
	} catch {
		// Parent went away — nothing to stream to. Exit cleanly.
		exit(0)
	}
}

// ---- window enumeration (CGWindowList: no TCC prompt, unlike AX) -------------------------
//
// CGWindowListCopyWindowInfo needs NO permission to read window GEOMETRY and ownership — it is
// the same data the Dock and Mission Control use. (Reading window CONTENTS is what needs the
// Screen Recording grant, and that is SCK below.) So window-follow selection is always
// available even before capture is authorized, which lets us report a precise "no screen
// recording" error against a window we can already name.

struct WindowInfo {
	let id: CGWindowID
	let title: String
	let app: String
	let pid: pid_t
	let bounds: CGRect
	let layer: Int
}

func onScreenWindows() -> [WindowInfo] {
	let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
	guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
	var out: [WindowInfo] = []
	for w in raw {
		guard let id = w[kCGWindowNumber as String] as? CGWindowID,
		      let pid = w[kCGWindowOwnerPID as String] as? pid_t,
		      let b = w[kCGWindowBounds as String] as? [String: CGFloat],
		      let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"]
		else { continue }
		let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
		let title = (w[kCGWindowName as String] as? String) ?? ""
		let app = (w[kCGWindowOwnerName as String] as? String) ?? ""
		out.append(WindowInfo(id: id, title: title, app: app, pid: pid,
		                      bounds: CGRect(x: x, y: y, width: width, height: height), layer: layer))
	}
	return out
}

// The frontmost *normal* window: layer 0 (kCGNormalWindowLevel), skipping the menu bar,
// Dock, wallpaper, and the tiny zero-area helper windows apps keep around. CGWindowList
// returns front-to-back, so the first match is the key window.
func frontmostWindow() -> WindowInfo? {
	for w in onScreenWindows() {
		if w.layer != 0 { continue }
		if w.bounds.width < 80 || w.bounds.height < 80 { continue }
		if w.app == "Window Server" || w.app == "Dock" { continue }
		return w
	}
	return nil
}

func windowById(_ id: CGWindowID) -> WindowInfo? {
	onScreenWindows().first { $0.id == id }
}

// The backing scale of the display the window actually occupies. NSScreen.main is the KEY
// window's screen — wrong for a background agent on a multi-display Mac, where the tracked
// window can sit anywhere. NSScreen frames are bottom-left-origin while CGWindowList/SCK
// frames are top-left, so flip through the primary display's height before hit-testing.
func backingScale(for cgFrame: CGRect) -> CGFloat {
	let fallback = NSScreen.main?.backingScaleFactor ?? 2.0
	guard let primary = NSScreen.screens.first else { return fallback }
	let mid = CGPoint(x: cgFrame.midX, y: primary.frame.height - cgFrame.midY)
	for s in NSScreen.screens where s.frame.contains(mid) {
		return s.backingScaleFactor
	}

	return fallback
}

// ---- AX inspection of a foreign (browser) window ------------------------------------------
//
// Two questions, one bounded tree walk: where is the page content (AXWebArea — Chromium and
// WebKit both expose it), and is the external-protocol confirmation on screen (an AXButton
// titled "Open <App>…"). Runs on its own serial queue because AX calls BLOCK on the target
// app — a browser wedged on a modal must stall the scan, never the capture or the input loop.
// The engine inherits the runner's Accessibility grant, the same inheritance axdom relies on.

let axQueue = DispatchQueue(label: "liveview.ax")

func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
	var ref: CFTypeRef?
	guard AXUIElementCopyAttributeValue(el, name as CFString, &ref) == .success else { return nil }
	return ref
}

func axFrame(_ el: AXUIElement) -> CGRect? {
	guard let posRef = axAttr(el, kAXPositionAttribute), let sizeRef = axAttr(el, kAXSizeAttribute) else { return nil }
	var p = CGPoint.zero
	var s = CGSize.zero
	guard AXValueGetValue(posRef as! AXValue, .cgPoint, &p), AXValueGetValue(sizeRef as! AXValue, .cgSize, &s) else { return nil }
	// AX speaks the same top-left-origin global coordinates CGWindowList does.
	return CGRect(origin: p, size: s)
}

// The AX window element matching the tracked CGWindow, by geometry: element ids and window ids
// live in different namespaces, and frame agreement (±4pt) is the only join available.
func axWindowElement(pid: pid_t, matching bounds: CGRect) -> AXUIElement? {
	let app = AXUIElementCreateApplication(pid)
	guard let wins = axAttr(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
	for w in wins {
		if let f = axFrame(w),
		   abs(f.origin.x - bounds.origin.x) < 4, abs(f.origin.y - bounds.origin.y) < 4,
		   abs(f.width - bounds.width) < 4, abs(f.height - bounds.height) < 4 { return w }
	}
	return wins.first
}

struct ForeignScan {
	/** Page-content rect in global points, when one was found. */
	var webArea: CGRect?
	/** Bounding box of the page's visible ink — the login card. Preferred over webArea. */
	var ink: CGRect?
	/** The "Open <App>" confirmation button, when it is on screen. */
	var openButton: AXUIElement?
	var openTitle: String = ""
}

// One bounded DFS answering both questions.
//
// The web area is chosen by AREA, not by DFS order, and this is load-bearing: measured on a real
// accounts.google.com window (2026-07-31), Chrome exposes TWO AXWebAreas — the page itself at
// depth 8 (748x812) and a degenerate 0x0 sibling at depth 11. First-match would take whichever
// the walk reached first, and a zero-size pick then failed the caller's sanity gate, which
// applied NO crop at all — the whole browser stayed visible. Largest-wins is stable under both
// orderings, and the real page content is always the biggest web area in its window.
//
// Budget is generous for the same measurement: the real web area sits behind ~30 AXGroups, and
// the old 900-node cap could exhaust before reaching it on a busier page — which also degraded
// to "no crop". Depth and node caps still exist so a pathological tree cannot wedge the 500ms
// cadence, they are simply set past what Chromium actually needs.
/// Roles that put actual ink on the page. The union of these inside the web area is the login
/// CARD, which is what the operator needs to see — measured on accounts.google.com
/// (2026-07-31): the web area is 748x812 while its ink is 468x488, just 37% of it. Cropping to
/// the web area therefore still framed mostly empty page background.
let INK_ROLES: Set<String> = [
	"AXStaticText", "AXTextField", "AXSecureTextField", "AXButton", "AXLink", "AXImage",
	"AXHeading", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXMenuButton",
]

func scanForeignWindow(_ root: AXUIElement, appName: String) -> ForeignScan {
	var out = ForeignScan()
	var budget = 12000
	var bestArea: CGFloat = 0
	var webEl: AXUIElement?
	let wanted = normalizedAppName(appName)

	func walk(_ el: AXUIElement, depth: Int) {
		if depth > 22 || budget <= 0 { return }
		budget -= 1
		let role = axAttr(el, kAXRoleAttribute) as? String ?? ""
		if role == "AXWebArea", let f = axFrame(el) {
			let area = f.width * f.height
			if area > bestArea {
				bestArea = area
				out.webArea = f
				webEl = el
			}
		}
		if role == "AXButton", out.openButton == nil {
			let title = axAttr(el, kAXTitleAttribute) as? String ?? ""
			// Chrome's external-protocol dialog: a button literally titled "Open <App>.app".
			// The app name must appear, or a page's own "Open settings" button would be pressed.
			if title.lowercased().hasPrefix("open "), normalizedAppName(title).contains(wanted) {
				out.openButton = el
				out.openTitle = title
			}
		}
		guard let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
		for k in kids { walk(k, depth: depth + 1) }
	}

	walk(root, depth: 0)

	// Second pass inside the winning web area: bound the ink. Deliberately separate from the
	// walk above — the union is only meaningful within ONE web area, and collecting it during a
	// walk that may still switch web areas would mix two pages' geometry.
	if let we = webEl, let web = out.webArea {
		var inkBudget = 12000
		var union: CGRect?
		var leaves = 0
		func inkWalk(_ el: AXUIElement, depth: Int) {
			if depth > 22 || inkBudget <= 0 { return }
			inkBudget -= 1
			if INK_ROLES.contains(axAttr(el, kAXRoleAttribute) as? String ?? ""), let f = axFrame(el),
			   f.width > 1, f.height > 1, web.intersects(f) {
				// Clipped to the web area: a scrolled-out element reports its layout frame, which
				// can sit far outside the viewport and would blow the union up to nothing useful.
				let vis = f.intersection(web)
				if vis.width > 1, vis.height > 1 {
					leaves += 1
					union = union == nil ? vis : union!.union(vis)
				}
			}
			guard let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
			for k in kids { inkWalk(k, depth: depth + 1) }
		}
		inkWalk(we, depth: 0)
		// A handful of leaves is a page mid-load, not a form; keep the web area until it settles.
		if leaves >= 3 { out.ink = union }
	}

	return out
}

// ---- JPEG encode ------------------------------------------------------------------------

func encodeJPEG(_ image: CGImage, quality: Float) -> Data? {
	let data = NSMutableData()
	guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
	CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
	guard CGImageDestinationFinalize(dest) else { return nil }
	return data as Data
}

// ---- capture engine ---------------------------------------------------------------------
//
// SCStream scoped to a single SCWindow via SCContentFilter(desktopIndependentWindow:). The
// filter is what gives Grade-2 isolation: SCK composites only that window's surface, so no
// other window's pixels are ever in a frame we could encode. We re-resolve the target every
// tick in follow mode; when the frontmost CGWindowID changes we rebuild the filter.

/// A value shared across the main loop, the AX queue and SCK's frame queue. The lock is the
/// whole point: a torn read of a CGRect mid-update would map one click against half-updated
/// crop geometry.
final class Shared<T> {
	private var v: T
	private let lock = NSLock()
	init(_ v: T) { self.v = v }
	var value: T {
		get { lock.lock(); defer { lock.unlock() }; return v }
		set { lock.lock(); v = newValue; lock.unlock() }
	}
}

final class Engine: NSObject, SCStreamOutput, SCStreamDelegate {
	enum Mode { case follow; case pinned(CGWindowID) }

	var mode: Mode = .follow
	private var stream: SCStream?
	private var rebuilding = false          // guards against concurrent rebuilds from the 250ms timer
	private var currentWindowId: CGWindowID?
	private var currentBounds: CGRect = .zero      // points, global (for input mapping)
	private var currentScale: CGFloat = 2.0
	private var currentApp = ""
	private var currentPid: pid_t = 0
	private let queue = DispatchQueue(label: "liveview.frames")
	private var shareable: SCShareableContent?
	private var lastEmit = Date.distantPast
	private let minInterval: TimeInterval

	// Constrained-browser state (see the header). The crop is held in GLOBAL POINTS — exactly
	// what AX reported — and converted to fractions at each use against the CURRENT bounds.
	// Storing fractions instead would freeze them to the geometry at scan time, and the OAuth
	// popup opens small and resizes itself a moment later: every frame and click between the
	// resize and the next scan would be mapped against a window that no longer exists.
	let foreign = Shared<Bool>(false)
	let cropPoints = Shared<CGRect?>(nil)
	/** Live window bounds, mirrored for the frame queue (which never touches main state). */
	let boundsBox = Shared<CGRect>(.zero)
	private var lastScanAt = Date.distantPast
	private var scanInFlight = false
	private var lastPressAt = Date.distantPast
	private var lastCropSent: CGRect?

	init(fps: Int) {
		self.minInterval = 1.0 / Double(fps)
	}

	func start() {
		Task { await self.tick() }
		// Re-evaluate the target on a timer; SCK pushes frames on its own, but window SWITCHES
		// (the OAuth handoff) are detected here.
		Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
			Task { await self.retarget() }
		}
	}

	private func desired() -> CGWindowID? {
		switch mode {
			case .follow: return frontmostWindow()?.id
			case .pinned(let id): return id
		}
	}

	private func tick() async { await retarget() }

	private func retarget() async {
		let want = desired()
		guard let want else {
			if currentWindowId != nil { emitError("no-window", "no capturable window is frontmost") }
			currentWindowId = nil
			return
		}
		if want == currentWindowId {
			refreshBounds(for: want)
			scheduleForeignScan()
			return
		}

		// The 250ms timer fires again while `rebuild` is still awaiting SCShareableContent, and the
		// guard above cannot catch it yet (currentWindowId only updates at the END of rebuild). Two
		// concurrent rebuilds for the same window would leave two live streams fighting over frames
		// — the exact thing rebuild's teardown warns about. `rebuilding` collapses the duplicate:
		// the in-flight rebuild wins, the next tick re-checks and either agrees or switches once.
		if rebuilding { return }
		rebuilding = true
		await rebuild(for: want)
		rebuilding = false
	}

	private func rebuild(for id: CGWindowID) async {
		let content: SCShareableContent
		do {
			// excludingDesktopWindows:false, onScreenWindowsOnly:true — matches our enumeration.
			content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
		} catch {
			// The single most common real failure: capture not authorized. CGWindowList still
			// works (we named the window), but SCK refuses without the grant.
			emitError("no-screen-recording", "\(error.localizedDescription)")
			return
		}
		guard let scWindow = content.windows.first(where: { $0.windowID == id }) else {
			emitError("no-window", "window \(id) is gone")
			return
		}

		// Tear down the old stream before building the new one, or two streams fight over frames.
		if let old = stream { try? await old.stopCapture() }

		let filter = SCContentFilter(desktopIndependentWindow: scWindow)
		let cfg = SCStreamConfiguration()
		let scale = backingScale(for: scWindow.frame)
		// Cap the encoded width; SCK wants pixel dimensions.
		let winW = scWindow.frame.width * scale
		let outW = min(CGFloat(maxWidth), winW)
		let ratio = winW > 0 ? outW / winW : 1
		cfg.width = Int(winW * ratio)
		cfg.height = Int(scWindow.frame.height * scale * ratio)
		cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
		cfg.queueDepth = 5
		// The REMOTE cursor is not composited into the stream. The physical pointer on a colo Mac
		// belongs to nobody — it sits wherever the last person left it — and injected input moves
		// it independently of where the operator is pointing, so a second cursor drifting around
		// the frame is pure confusion. The operator's own browser cursor is the only pointer that
		// should be visible, and it is drawn locally by their OS.
		cfg.showsCursor = false

		let s = SCStream(filter: filter, configuration: cfg, delegate: self)
		do {
			try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
			try await s.startCapture()
		} catch {
			emitError("capture-failed", "\(error.localizedDescription)")
			return
		}
		stream = s
		currentWindowId = id
		currentBounds = scWindow.frame     // global points
		currentScale = scale
		currentApp = scWindow.owningApplication?.applicationName ?? ""
		currentPid = scWindow.owningApplication?.processID ?? 0
		// A window switch resets the constrained state: the new window's own scan re-derives it,
		// and stale crop fractions from the browser must never map clicks inside the app.
		foreign.value = isForeign(app: currentApp)
		cropPoints.value = nil
		boundsBox.value = scWindow.frame
		lastCropSent = nil
		emitWindowEvent(id: id, title: scWindow.title ?? "", app: currentApp)
		scheduleForeignScan()
	}

	/**
	 * The crop as fractions of the window RIGHT NOW, or nil when there is none (or when it no
	 * longer meaningfully overlaps the window — a stale rect from before a move must not crop
	 * a sliver, since uncropped is merely the old behavior).
	 */
	func cropFraction() -> CGRect? {
		guard let c = cropPoints.value else { return nil }
		let b = boundsBox.value
		guard b.width > 1, b.height > 1 else { return nil }
		let inter = c.intersection(b)
		// Absolute floor, not a fraction of the window: the point of the crop is that a login
		// card is SMALL relative to its window (measured ~37% of the web area on Google's page,
		// less of the window), so an area-ratio gate would veto exactly the crops worth making.
		// What must be rejected is a DEGENERATE rect — a collapsed mid-load element — and 200pt
		// on a side is below any real form yet far above the 0x0 and sliver cases.
		guard inter.width >= 200, inter.height >= 160 else { return nil }

		return CGRect(x: (inter.origin.x - b.origin.x) / b.width, y: (inter.origin.y - b.origin.y) / b.height,
		              width: inter.width / b.width, height: inter.height / b.height)
	}

	/** The window event, with the constrained-mode fields riding along for the log and tests. */
	private func emitWindowEvent(id: CGWindowID, title: String, app: String) {
		var ev: [String: Any] = [
			"ev": "window", "id": Int(id),
			"title": title, "app": app,
			"x": currentBounds.origin.x, "y": currentBounds.origin.y,
			"w": currentBounds.width, "h": currentBounds.height, "scale": currentScale,
			"foreign": foreign.value,
		]
		if let c = cropFraction() {
			ev["crop"] = ["x": c.origin.x, "y": c.origin.y, "w": c.width, "h": c.height]
		}
		emitEvent(ev)
	}

	/**
	 * Re-derive the constrained-browser facts for the CURRENT window, off the main loop. Every
	 * 500ms while a target app is named: the web area appears only once the page loads, and the
	 * "Open <App>" dialog appears at the END of the flow — one scan at window-switch would miss
	 * both. Results are applied on main only if the window has not changed underneath the scan.
	 */
	private func scheduleForeignScan() {
		guard !targetApp.isEmpty, let id = currentWindowId, foreign.value else { return }
		guard !scanInFlight, Date().timeIntervalSince(lastScanAt) >= 0.5 else { return }
		scanInFlight = true
		lastScanAt = Date()
		let pid = currentPid
		let bounds = currentBounds
		let app = targetApp

		axQueue.async { [weak self] in
			var scan = ForeignScan()
			if let winEl = axWindowElement(pid: pid, matching: bounds) {
				scan = scanForeignWindow(winEl, appName: app)
			}
			DispatchQueue.main.async {
				guard let self, self.currentWindowId == id else { self?.scanInFlight = false; return }
				self.scanInFlight = false
				self.applyScan(scan, windowId: id)
			}
		}
	}

	private func applyScan(_ scan: ForeignScan, windowId: CGWindowID) {
		// Prefer the INK box (the login card) over the whole web area, with breathing room so
		// the card is not cut flush to its own edge. The ink is 37% of the web area on a real
		// Google sign-in page, which is the difference between "a card filling the view" and
		// "a small card adrift in page background".
		var target = scan.ink ?? scan.webArea
		if let ink = scan.ink, let web = scan.webArea {
			// Asymmetric-friendly but simple: enough that a card is never cut flush to its own
			// rounded corner or its logo. Measured too tight at 8% — Google's mark sits above
			// the first ink element and lost its top.
			let padX = max(32, ink.width * 0.10)
			let padY = max(40, ink.height * 0.12)
			target = ink.insetBy(dx: -padX, dy: -padY).intersection(web)
		}
		// Store in POINTS; cropFraction() re-derives fractions per use and applies the sanity
		// gate against live geometry, so a resize between scans cannot leave a wrong crop.
		cropPoints.value = target
		let next = cropFraction()
		// Say so when the crop meaningfully changes — the parent's log is how a mis-crop gets
		// diagnosed from a transcript — but not on every 500ms tick of an unchanged one.
		let moved: Bool = {
			guard let a = lastCropSent, let b = next else { return (lastCropSent == nil) != (next == nil) }
			return abs(a.origin.x - b.origin.x) > 0.02 || abs(a.origin.y - b.origin.y) > 0.02 ||
				abs(a.width - b.width) > 0.02 || abs(a.height - b.height) > 0.02
		}()
		if moved {
			lastCropSent = next
			emitWindowEvent(id: windowId, title: "", app: currentApp)
		}

		// The hands-free redirect. Debounced: the dialog outlives the press by a frame or two,
		// and pressing "Open Yarn.app" twice opens the app twice.
		if let btn = scan.openButton, Date().timeIntervalSince(lastPressAt) >= 3.0 {
			lastPressAt = Date()
			let title = scan.openTitle
			axQueue.async {
				if AXUIElementPerformAction(btn, kAXPressAction as CFString) == .success {
					emitEvent(["ev": "auto", "pressed": title])
				}
			}
		}
	}

	// The tracked window can move or resize WITHOUT changing identity — an OAuth popup resizing
	// itself after the page loads, a login sheet recentering — and SCK keeps streaming the right
	// pixels because the filter follows the window, which makes the stream look fine while
	// globalPoint is still mapping input against where the window USED to be: clicks land at the
	// old screen position, possibly in another app. CGWindowList geometry is cheap and needs no
	// TCC prompt, so re-read it on every retarget tick and tell the viewer when it changed.
	private func refreshBounds(for id: CGWindowID) {
		guard let w = windowById(id), w.bounds != currentBounds else { return }
		currentBounds = w.bounds
		boundsBox.value = w.bounds
		currentApp = w.app
		currentPid = w.pid
		foreign.value = isForeign(app: w.app)
		emitWindowEvent(id: id, title: w.title, app: w.app)
	}

	// Map a 0..1 fraction of the tracked window to a global screen point for CGEvent. Clamped
	// HERE and nowhere else — this is the one point every input path funnels through, whereas
	// the TS helpers are optional for callers — so an unvalidated x:3 from the wire cannot
	// click three window-widths into whatever app happens to sit there.
	func globalPoint(fx: Double, fy: Double) -> CGPoint {
		var cx = min(max(fx.isFinite ? fx : 0, 0.0), 1.0)
		var cy = min(max(fy.isFinite ? fy : 0, 0.0), 1.0)
		// The viewer only ever SEES the crop, so its fractions are fractions OF the crop — the
		// remap is what makes the toolbar physically unreachable, not just invisible: even a
		// crafted x:0 y:0 lands on the crop's own corner, inside the page content.
		if let c = cropFraction() {
			cx = Double(c.origin.x) + cx * Double(c.width)
			cy = Double(c.origin.y) + cy * Double(c.height)
		}

		return CGPoint(x: currentBounds.origin.x + CGFloat(cx) * currentBounds.width,
		               y: currentBounds.origin.y + CGFloat(cy) * currentBounds.height)
	}

	// SCStreamOutput
	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen, CMSampleBufferIsValid(sampleBuffer),
		      let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
		let now = Date()
		if now.timeIntervalSince(lastEmit) < minInterval { return }
		lastEmit = now
		var cg: CGImage?
		VTCreateCGImageFromCVPixelBuffer(pixel, options: nil, imageOut: &cg)
		guard var image = cg else { return }
		// The crop applies at encode: only the page content's pixels ever leave the process, so
		// the URL bar is absent from the stream itself, not merely hidden by the viewer. Crop
		// fractions and CGImage.cropping both speak top-left-origin, same as CGWindowList.
		if let c = cropFraction() {
			let rect = CGRect(x: c.origin.x * CGFloat(image.width), y: c.origin.y * CGFloat(image.height),
			                  width: c.width * CGFloat(image.width), height: c.height * CGFloat(image.height)).integral
			if rect.width >= 64, rect.height >= 64, let cropped = image.cropping(to: rect) { image = cropped }
		}
		guard let jpeg = encodeJPEG(image, quality: quality) else { return }
		emitFrame(jpeg)
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		emitError("stream-stopped", "\(error.localizedDescription)")
		currentWindowId = nil
	}
}

// ---- input injection (CGEvent; needs Accessibility) -------------------------------------

final class Injector {
	private let src = CGEventSource(stateID: .hidSystemState)
	// Which buttons are held, tracked from our own down/up. macOS apps treat .mouseMoved between
	// a down and an up as hover, not a drag — drag-select, sliders, and scrollbars only respond
	// to the *MouseDragged types — and the viewer keeps sending plain moves during a drag, so
	// the held state here, not the message, decides how a move is posted.
	private var leftDown = false
	private var rightDown = false

	func mouse(_ type: String, at p: CGPoint, button: String) {
		var btn: CGMouseButton = button == "right" ? .right : .left
		let evType: CGEventType
		switch type {
			case "down":
				evType = btn == .right ? .rightMouseDown : .leftMouseDown
				if btn == .right { rightDown = true } else { leftDown = true }
			case "up":
				evType = btn == .right ? .rightMouseUp : .leftMouseUp
				if btn == .right { rightDown = false } else { leftDown = false }
			default:
				if leftDown { evType = .leftMouseDragged; btn = .left }
				else if rightDown { evType = .rightMouseDragged; btn = .right }
				else { evType = .mouseMoved }
		}
		if let e = CGEvent(mouseEventSource: src, mouseType: evType, mouseCursorPosition: p, mouseButton: btn) {
			e.post(tap: .cghidEventTap)
		}
	}

	func click(at p: CGPoint, button: String) {
		mouse("down", at: p, button: button)
		mouse("up", at: p, button: button)
	}

	func scroll(dy: Int32, dx: Int32) {
		if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
			e.post(tap: .cghidEventTap)
		}
	}

	func key(down: Bool, code: CGKeyCode, flags: CGEventFlags) {
		if let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) {
			e.flags = flags
			e.post(tap: .cghidEventTap)
		}
	}

	// Type a unicode string by posting keyboard events with the character payload — this is how
	// pasted credential values reach a field without a per-character keycode table.
	func text(_ s: String) {
		for ch in s {
			let utf16 = Array(String(ch).utf16)
			if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
				down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
				down.post(tap: .cghidEventTap)
			}
			if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
				up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
				up.post(tap: .cghidEventTap)
			}
		}
	}
}

// ---- command loop -----------------------------------------------------------------------

let engine = Engine(fps: fps)
let injector = Injector()
engine.start()

func handle(_ obj: [String: Any]) {
	guard let cmd = obj["cmd"] as? String else { return }
	switch cmd {
		case "follow": engine.mode = .follow
		// Wire-controlled ints must never hit a trapping initializer — one malformed message
		// ("code":-1) would SIGTRAP the engine mid-login. Values with an exact target range
		// (window id, keycode) are ignored when out of range, like unknown cmds below; deltas
		// and flags clamp, because a saturated scroll is harmless where a crash is not.
		case "pin": if let id = obj["window"] as? Int, let wid = CGWindowID(exactly: id) { engine.mode = .pinned(wid) }
		case "mouse":
			let p = engine.globalPoint(fx: obj["x"] as? Double ?? 0, fy: obj["y"] as? Double ?? 0)
			let type = obj["type"] as? String ?? "move"
			let button = obj["button"] as? String ?? "left"
			if type == "click" { injector.click(at: p, button: button) } else { injector.mouse(type, at: p, button: button) }
		case "scroll":
			// Scroll wheels land under wherever the pointer IS — the event carries no position of
			// its own. The protocol sends x/y precisely so the scroll can be aimed; without the
			// move first, the wheel turns under the physical cursor, possibly in another app.
			if let fx = obj["x"] as? Double, let fy = obj["y"] as? Double {
				injector.mouse("move", at: engine.globalPoint(fx: fx, fy: fy), button: "left")
			}
			injector.scroll(dy: Int32(clamping: obj["dy"] as? Int ?? 0), dx: Int32(clamping: obj["dx"] as? Int ?? 0))
		case "key":
			guard let code = CGKeyCode(exactly: obj["code"] as? Int ?? 0) else { break }
			let flags = CGEventFlags(rawValue: UInt64(clamping: obj["flags"] as? Int ?? 0))
			// The keyboard half of the URL-bar guard: over a browser, Cmd+L focuses the address
			// bar with no click for the crop to stop, and Cmd+T/N mint fresh chrome. Cmd passes
			// only for the edit set — paste MUST survive, because passwords and 2FA codes arrive
			// by paste. ANSI codes: A=0, Z=6, X=7, C=8, V=9. Dropped keys are reported, not
			// swallowed: a teammate whose shortcut does nothing needs the log to say why.
			if engine.foreign.value, flags.contains(.maskCommand), ![0, 6, 7, 8, 9].contains(Int(code)) {
				if obj["down"] as? Bool ?? true { emitEvent(["ev": "blocked", "what": "key", "code": Int(code)]) }
				break
			}
			injector.key(down: obj["down"] as? Bool ?? true, code: code, flags: flags)
		case "text":
			if let s = obj["s"] as? String { injector.text(s) }
		case "quit": exit(0)
		default: break
	}
}

// Read stdin line by line off the main runloop so SCK's callbacks keep flowing.
let stdinQueue = DispatchQueue(label: "liveview.stdin")
stdinQueue.async {
	while let line = readLine(strippingNewline: true) {
		guard let data = line.data(using: .utf8),
		      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
		DispatchQueue.main.async { handle(obj) }
	}
	// stdin closed: parent is gone.
	exit(0)
}

// SCStream delivers on its own queue; keep the process alive on the main runloop.
RunLoop.main.run()
