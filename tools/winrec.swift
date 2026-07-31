import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

// winrec — record a single window (by CGWindowID) to an mp4 via an SCK live stream
// (desktop-independent window filter). Pixel-perfect and occlusion-proof; suspends
// (gap in the video) while the window is off its display's active Space. Stops and
// finalizes on SIGINT/SIGTERM.
//
// usage: winrec <windowID> <output.mp4>

_ = CGMainDisplayID()
_ = NSApplication.shared

let args = CommandLine.arguments
guard args.count >= 3, let windowID = UInt32(args[1]) else {
	FileHandle.standardError.write("usage: winrec <windowID> <output.mp4>\n".data(using: .utf8)!)
	exit(1)
}
let outputURL = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: outputURL)

func log(_ s: String) {
	FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

final class FrameWriter: NSObject, SCStreamOutput {
	private let writer: AVAssetWriter
	private let input: AVAssetWriterInput
	private var sessionStarted = false
	private(set) var frames = 0

	init(url: URL, width: Int, height: Int) throws {
		writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
		input = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: width,
			AVVideoHeightKey: height,
		])
		input.expectsMediaDataInRealTime = true
		writer.add(input)
		super.init()
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen, sampleBuffer.isValid else { return }
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
		      let statusRaw = attachments.first?[.status] as? Int,
		      SCFrameStatus(rawValue: statusRaw) == .complete
		else { return }

		if !sessionStarted {
			sessionStarted = true
			writer.startWriting()
			writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
			log("first frame")
		}
		if input.isReadyForMoreMediaData {
			input.append(sampleBuffer)
			frames += 1
		}
	}

	func finish() async {
		guard sessionStarted else {
			FileHandle.standardError.write("no frames captured\n".data(using: .utf8)!)
			return
		}
		input.markAsFinished()
		await writer.finishWriting()
		log("finalized \(frames) frames")
	}
}

var activeStream: SCStream?
var frameWriter: FrameWriter?

Task {
	do {
		let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
		guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
			FileHandle.standardError.write("window \(windowID) not found\n".data(using: .utf8)!)
			exit(2)
		}

		// SCWindow.frame is in points; capture at the backing scale of the display the
		// window actually sits on, or a 1x screen gets a 2x-upscaled stream — double the
		// resolution and file size for pixels that do not exist. SCWindow.frame is top-left
		// CG space while NSScreen frames are bottom-left AppKit space, so flip each screen
		// against the primary before intersecting; the screen holding most of the window
		// wins. 2.0 only when nothing overlaps (mid-drag between displays, stale frame).
		let scale: CGFloat = {
			guard let primary = NSScreen.screens.first else { return 2.0 }
			var best: (area: CGFloat, scale: CGFloat) = (0, 2.0)
			for screen in NSScreen.screens {
				let f = screen.frame
				let cg = CGRect(x: f.minX, y: primary.frame.maxY - f.maxY, width: f.width, height: f.height)
				let overlap = cg.intersection(window.frame)
				let area = overlap.isNull ? 0 : overlap.width * overlap.height
				if area > best.area { best = (area, screen.backingScaleFactor) }
			}
			return best.scale
		}()
		let width = (Int(window.frame.width * scale)) & ~1
		let height = (Int(window.frame.height * scale)) & ~1

		let filter = SCContentFilter(desktopIndependentWindow: window)
		let config = SCStreamConfiguration()
		config.width = width
		config.height = height
		config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
		config.pixelFormat = kCVPixelFormatType_32BGRA
		config.showsCursor = false
		config.capturesAudio = false

		let stream = SCStream(filter: filter, configuration: config, delegate: nil)
		activeStream = stream

		let fw = try FrameWriter(url: outputURL, width: width, height: height)
		frameWriter = fw
		try stream.addStreamOutput(fw, type: .screen, sampleHandlerQueue: DispatchQueue(label: "winrec.frames"))

		try await stream.startCapture()
		log("recording window \(windowID) (\(width)x\(height)) -> \(outputURL.path)")
	} catch {
		FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
		exit(3)
	}
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

func stopHandler(_ sig: Int32) -> DispatchSourceSignal {
	let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
	src.setEventHandler {
		Task {
			try? await activeStream?.stopCapture()
			await frameWriter?.finish()
			exit(0)
		}
	}
	src.resume()
	return src
}

let sigint = stopHandler(SIGINT)
let sigterm = stopHandler(SIGTERM)

RunLoop.main.run()
