// axdom — emit the DOM-derived AX attributes that cua-driver's element projection drops.
//
// Chromium's Mac accessibility bridge (browser_accessibility_cocoa.mm) exposes the
// originating DOM node's id and class list as nonstandard AX attributes, alongside the
// ARIA-spec'd role/title/value. The driver reads only role/label/value/frame, so an
// icon button whose developers never wrote an aria-label arrives as AXButton "" — present
// but anonymous. The DOM attributes are still there on the element; nobody asked for them.
//
// Measured on Yarn (1488 nodes): 955 of 1044 anonymous nodes carry a DOM id or class,
// including 37 of the 64 anonymous *interactive* controls.
//
// Output: one JSON object per line (JSONL), so the caller can stream and cheaply join.
// Keyed by AXFrame geometry, which is the only identifier this walk and the driver's
// walk both observe — element_index is per-walk ordering and is NOT comparable.
//
// Usage: axdom <pid> [maxNodes]
import ApplicationServices
import Foundation

let INTERESTING_TEXT = [
	"AXHelp",              // title="" / aria-description -> tooltip text
	"AXDescription",       // accessible description
	"AXPlaceholderValue",  // input placeholder
	"AXURL",               // link/webarea target
	"AXRoleDescription",   // Chromium's human role name, often better than the raw role
]

let args = CommandLine.arguments
guard args.count >= 2, let pid = Int32(args[1]) else {
	FileHandle.standardError.write("usage: axdom <pid> [maxNodes]\n".data(using: .utf8)!)
	exit(2)
}
let maxNodes = args.count >= 3 ? (Int(args[2]) ?? 3000) : 3000

let app = AXUIElementCreateApplication(pid)

// Chromium builds the web-content AX tree lazily: until a client announces itself the
// tree can be menu-bar-only. Harmless if the driver already switched it on.
AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

func raw(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
	var v: CFTypeRef?

	return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}

func text(_ el: AXUIElement, _ attr: String) -> String {
	guard let v = raw(el, attr) else { return "" }
	if let s = v as? String { return s }
	if let arr = v as? [Any] { return arr.map { "\($0)" }.joined(separator: " ") }
	if let n = v as? NSNumber { return n.stringValue }

	return ""
}

func children(_ el: AXUIElement) -> [AXUIElement] {
	(raw(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

/// Screen-space frame, rounded to whole pixels — the join key against the driver's frames.
func frame(_ el: AXUIElement) -> (Int, Int, Int, Int)? {
	guard let v = raw(el, "AXFrame") else { return nil }
	var rect = CGRect.zero
	guard AXValueGetValue(v as! AXValue, .cgRect, &rect) else { return nil }

	return (Int(rect.origin.x.rounded()), Int(rect.origin.y.rounded()),
	        Int(rect.size.width.rounded()), Int(rect.size.height.rounded()))
}

func jsonEscape(_ s: String) -> String {
	var out = ""
	for c in s.unicodeScalars {
		switch c {
			case "\"": out += "\\\""
			case "\\": out += "\\\\"
			case "\n", "\r", "\t": out += " "
			default:
				if c.value < 0x20 { out += " " } else { out.unicodeScalars.append(c) }
		}
	}

	return out
}

var visited = 0
var emitted = 0

func walk(_ el: AXUIElement) {
	if visited >= maxNodes { return }
	visited += 1

	let domId = text(el, "AXDOMIdentifier")
	let domClass = text(el, "AXDOMClassList")
	var extras: [String: String] = [:]
	for attr in INTERESTING_TEXT {
		let v = text(el, attr)
		if !v.isEmpty { extras[attr] = v }
	}

	// Only emit rows that actually add information beyond what the driver already has.
	if let f = frame(el), !domId.isEmpty || !domClass.isEmpty || !extras.isEmpty {
		var fields = [
			"\"x\":\(f.0)", "\"y\":\(f.1)", "\"w\":\(f.2)", "\"h\":\(f.3)",
			"\"role\":\"\(jsonEscape(text(el, kAXRoleAttribute as String)))\"",
		]
		if !domId.isEmpty { fields.append("\"domId\":\"\(jsonEscape(domId))\"") }
		if !domClass.isEmpty { fields.append("\"domClass\":\"\(jsonEscape(domClass))\"") }
		for (k, v) in extras.sorted(by: { $0.key < $1.key }) {
			let key = k.hasPrefix("AX") ? String(k.dropFirst(2)) : k
			fields.append("\"\(key.prefix(1).lowercased() + key.dropFirst())\":\"\(jsonEscape(v))\"")
		}
		print("{\(fields.joined(separator: ","))}")
		emitted += 1
	}

	for c in children(el) { walk(c) }
}

walk(app)
FileHandle.standardError.write("axdom: visited \(visited), emitted \(emitted)\n".data(using: .utf8)!)
