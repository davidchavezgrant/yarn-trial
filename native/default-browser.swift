// default-browser — read LaunchServices' default https handler, or ask it to become Chrome.
//
// Exists because the LaunchServices API is unreachable from a shell, and macOS has NO silent
// programmatic path for changing the default browser: every route — the deprecated
// LSSetDefaultHandlerForURLScheme as much as NSWorkspace.setDefaultApplication — ends in the
// same user-confirmation dialog, posted by the console user's CoreServicesUIAgent on the
// Mac's own screen. MDM is the only exception, and this fleet has none (measured 2026-07-31;
// see src/remote/chrome-policy.ts). So `set` here TRIGGERS the dialog and waits, bounded,
// while a human clicks once via Screen Sharing or liveview. The only caller is
// install-default-browser.sh, staged by src/remote/control/provision.ts.
//
// Usage:
//   default-browser read                     prints the https handler's bundle id, exit 0
//   default-browser set <app path> [secs]    requests the browser-role swap, waits up to
//                                            <secs> (default 40) for the user's answer, and
//                                            prints the handler as it stands afterwards.
//                                            exit 0 = confirmed, 4 = still pending / refused
//
// `read` asks for the https handler because the OAuth handoff is an https URL; `set`
// requests the "http" scheme, which is the browser-role change — macOS moves http, https and
// the HTML document types together behind its one dialog.
//
// Build: npm run build:native (the binary is gitignored; it reaches fleet Macs by rsync,
// exactly like the axdom sidecar).
import AppKit
import Foundation

func fail(_ message: String, code: Int32) -> Never {
	FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
	exit(code)
}

/// What LaunchServices would open an https URL with, as a bundle id. "none" is a real answer
/// on a machine with no browser at all, not an error — the caller compares strings.
func handlerBundleId() -> String {
	guard let probe = URL(string: "https://example.com"),
	      let app = NSWorkspace.shared.urlForApplication(toOpen: probe) else { return "none" }

	return Bundle(url: app)?.bundleIdentifier ?? app.path
}

let args = CommandLine.arguments
switch args.count >= 2 ? args[1] : "" {
case "read":
	print(handlerBundleId())
	exit(0)

case "set":
	guard args.count >= 3 else { fail("usage: default-browser set <app path> [seconds]", code: 2) }
	guard #available(macOS 12.0, *) else { fail("macOS 12+ required", code: 2) }
	let appURL = URL(fileURLWithPath: args[2])
	guard let wantId = Bundle(url: appURL)?.bundleIdentifier else { fail("no app bundle at \(args[2])", code: 2) }
	let wait = args.count >= 4 ? (Double(args[3]) ?? 40) : 40

	var answered = false
	var failure: Error?
	NSWorkspace.shared.setDefaultApplication(at: appURL, toOpenURLsWithScheme: "http") { error in
		failure = error
		answered = true
	}

	// The completion fires when the user answers the dialog — or at once, on refusal. Spin the
	// run loop rather than parking on a semaphore: AppKit makes no promise about which queue
	// the handler lands on, and a blocked main thread would deadlock the main-queue case.
	let deadline = Date(timeIntervalSinceNow: wait)
	while !answered && Date() < deadline {
		RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.25))
	}

	// Report what LaunchServices actually says now, not what the API promised. The two agree
	// only after the human has clicked.
	let now = handlerBundleId()
	print(now)
	if let failure { FileHandle.standardError.write("\(failure.localizedDescription)\n".data(using: .utf8)!) }
	exit(now == wantId ? 0 : 4)

default:
	fail("usage: default-browser read | set <app path> [seconds]", code: 2)
}
