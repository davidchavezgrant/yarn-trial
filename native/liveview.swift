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
//     x/y are 0..1 fractions of the tracked window, so the viewer never needs to know pixels.
//
//   fd 3   (binary frames): each frame is  "F" <uint32 length BE> <jpeg bytes>.
//   stdout (JSONL events):  {"ev":"window","id":..,"title":..,"app":..,"x":..,"y":..,"w":..,"h":..,"scale":..}
//                           {"ev":"error","kind":"no-screen-recording|no-window|..","detail":".."}
//
// Usage: liveview [--fps N] [--quality Q] [--max-width W]
//
// Durable exit: this is trial tooling. If Yarn ships its own capture pipeline, this is deleted.
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import VideoToolbox

// ---- args -------------------------------------------------------------------------------

var fps = 15
var quality: Float = 0.6
var maxWidth = 1280
do {
	var it = CommandLine.arguments.dropFirst().makeIterator()
	while let a = it.next() {
		switch a {
			case "--fps": if let v = it.next(), let n = Int(v) { fps = max(1, min(60, n)) }
			case "--quality": if let v = it.next(), let q = Float(v) { quality = max(0.1, min(1.0, q)) }
			case "--max-width": if let v = it.next(), let w = Int(v) { maxWidth = max(320, w) }
			default: break
		}
	}
}

// ---- typed stderr/stdout so the parent can react rather than parse prose -----------------

let errOut = FileHandle.standardError
let evOut = FileHandle.standardOutput
// fd 3 is opened by the parent for binary frames. If it is absent (running by hand) fall back
// to /dev/null so a smoke test does not blow up on a bad write.
let frameFd: FileHandle = {
	let fh = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
	// Probe: writing zero bytes to a closed fd throws on Darwin.
	return fh
}()

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

final class Engine: NSObject, SCStreamOutput, SCStreamDelegate {
	enum Mode { case follow; case pinned(CGWindowID) }

	var mode: Mode = .follow
	private var stream: SCStream?
	private var rebuilding = false          // guards against concurrent rebuilds from the 250ms timer
	private var currentWindowId: CGWindowID?
	private var currentBounds: CGRect = .zero      // points, global (for input mapping)
	private var currentScale: CGFloat = 2.0
	private let queue = DispatchQueue(label: "liveview.frames")
	private var shareable: SCShareableContent?
	private var lastEmit = Date.distantPast
	private let minInterval: TimeInterval

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
		if want == currentWindowId { return }

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
		let scale = NSScreen.main?.backingScaleFactor ?? 2.0
		// Cap the encoded width; SCK wants pixel dimensions.
		let winW = scWindow.frame.width * scale
		let outW = min(CGFloat(maxWidth), winW)
		let ratio = winW > 0 ? outW / winW : 1
		cfg.width = Int(winW * ratio)
		cfg.height = Int(scWindow.frame.height * scale * ratio)
		cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
		cfg.queueDepth = 5
		cfg.showsCursor = true

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
		emitEvent([
			"ev": "window", "id": Int(id),
			"title": scWindow.title ?? "", "app": scWindow.owningApplication?.applicationName ?? "",
			"x": scWindow.frame.origin.x, "y": scWindow.frame.origin.y,
			"w": scWindow.frame.width, "h": scWindow.frame.height, "scale": scale,
		])
	}

	// Map a 0..1 fraction of the tracked window to a global screen point for CGEvent.
	func globalPoint(fx: Double, fy: Double) -> CGPoint {
		CGPoint(x: currentBounds.origin.x + CGFloat(fx) * currentBounds.width,
		        y: currentBounds.origin.y + CGFloat(fy) * currentBounds.height)
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
		guard let cg, let jpeg = encodeJPEG(cg, quality: quality) else { return }
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

	func mouse(_ type: String, at p: CGPoint, button: String) {
		let btn: CGMouseButton = button == "right" ? .right : .left
		let evType: CGEventType
		switch type {
			case "down": evType = btn == .right ? .rightMouseDown : .leftMouseDown
			case "up": evType = btn == .right ? .rightMouseUp : .leftMouseUp
			case "move": evType = .mouseMoved
			default: evType = .mouseMoved
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
		case "pin": if let id = obj["window"] as? Int { engine.mode = .pinned(CGWindowID(id)) }
		case "mouse":
			let p = engine.globalPoint(fx: obj["x"] as? Double ?? 0, fy: obj["y"] as? Double ?? 0)
			let type = obj["type"] as? String ?? "move"
			let button = obj["button"] as? String ?? "left"
			if type == "click" { injector.click(at: p, button: button) } else { injector.mouse(type, at: p, button: button) }
		case "scroll":
			injector.scroll(dy: Int32(obj["dy"] as? Int ?? 0), dx: Int32(obj["dx"] as? Int ?? 0))
		case "key":
			injector.key(down: obj["down"] as? Bool ?? true,
			             code: CGKeyCode(obj["code"] as? Int ?? 0),
			             flags: CGEventFlags(rawValue: UInt64(obj["flags"] as? Int ?? 0)))
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
