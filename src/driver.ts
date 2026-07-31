import {
	ClickButton,
	ClickInput,
	CuaDriver,
	type CuaDriverLike,
	DesktopScope,
	EndSessionInput,
	GetDesktopStateInput,
	HotkeyInput,
	PressKeyInput,
	ScrollDirection,
	ScrollInput,
	StartSessionInput,
	TypeTextInput,
	type ToolResult,
} from "@trycua/cua-driver";
import type { ActionRequest, Observation } from "./types.js";

const BUTTONS = { left: ClickButton.Left, right: ClickButton.Right, middle: ClickButton.Middle };

/**
 * How often to re-declare the session, to stay ahead of the driver's 300s session lifetime.
 *
 * Measured 2026-07-29, two probes. A session kept continuously busy — an action every five
 * seconds, never idle — died at 300.1s. A session poked after idle gaps of 60/90/120s was
 * still alive at 275s and dead by 455s. So the limit is an ABSOLUTE lifetime from
 * start_session, not an idle timeout: activity does not extend it.
 *
 * That is what killed two consecutive exploration passes at action 15. Explore averages
 * ~20s per action, so 300s lands on action 15 — a wall-clock deadline masquerading as a
 * step limit, which is why it looked so reproducible.
 *
 * 90s gives three refreshes per lifetime, so a transient failure has two more chances
 * before the session is actually lost.
 */
const HEARTBEAT_MS = 90_000;

/**
 * Both error codes the driver uses for "your session is gone". They are not
 * interchangeable in its own output — the busy probe got session_not_started, the idle
 * probe got session_ended — so recovery has to match on both or it silently misses half.
 */
const DEAD_SESSION = new Set(["session_ended", "session_not_started"]);

const SCROLL_DIRECTIONS = {
	up: ScrollDirection.Up,
	down: ScrollDirection.Down,
	left: ScrollDirection.Left,
	right: ScrollDirection.Right,
};

/**
 * The only module that touches @trycua/cua-driver. Everything above this
 * boundary speaks Observation/ActionRequest, so the actuator can be swapped
 * (daemon connection, MCP client, native sidecar) without touching the loop.
 */
export class Driver {
	/** Times the session was re-declared after the driver reclaimed it. Surfaced in run logs. */
	revivals = 0;

	private inner: CuaDriverLike;
	private session: string;
	private heartbeat?: NodeJS.Timeout;
	/** Set the moment close() begins; a tick that fires after this must not re-declare the session. */
	private closing = false;
	/** The heartbeat call currently on the wire, so close() can wait it out before tearing down. */
	private heartbeatInFlight?: Promise<unknown>;

	private constructor(inner: CuaDriverLike, session: string) {
		this.inner = inner;
		this.session = session;
	}

	static async start(session: string): Promise<Driver> {
		const inner = CuaDriver.create(undefined);
		if (!inner.isAvailable()) throw new Error("cua-driver native library unavailable on this host");

		await inner.startSession(StartSessionInput.new({ session }));
		const driver = new Driver(inner, session);
		driver.startHeartbeat();

		return driver;
	}

	async listTools(): Promise<string> {
		return this.inner.listToolsJson();
	}

	async observe(screenshotOutFile?: string): Promise<Observation> {
		const result = await this.inner.getDesktopState(
			GetDesktopStateInput.new({ session: this.session, screenshotOutFile }),
		);
		this.throwIfError(result, "getDesktopState");

		return {
			text: result.text,
			screenshotPath: screenshotOutFile,
			structured: result.structuredJson ? JSON.parse(result.structuredJson) : undefined,
			degraded: result.degraded,
		};
	}

	async act(action: ActionRequest): Promise<ToolResult> {
		let result = await this.dispatch(action);

		// A reclaimed session is recoverable: re-declaring it costs one call and
		// nothing about the app's state depends on the session's identity. Retry
		// once only — a second failure is a real fault, not a lapsed timer.
		if (result.isError && DEAD_SESSION.has(result.errorCode ?? "")) {
			this.revivals++;
			console.warn(`  driver session '${this.session}' expired (${result.errorCode}) — re-declaring and retrying`);
			await this.inner.startSession(StartSessionInput.new({ session: this.session }));
			result = await this.dispatch(action);
		}
		this.throwIfError(result, action.kind);

		return result;
	}

	async close(): Promise<void> {
		// clearInterval only stops FUTURE ticks. A heartbeat already on the wire would
		// otherwise resolve after endSession — re-declaring a session nobody will ever end,
		// against a uniffi handle that may already be destroyed. Flag first so the next tick
		// stays home, then drain the one in flight before tearing anything down.
		this.closing = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.heartbeatInFlight) await this.heartbeatInFlight.catch(() => {});
		await this.inner.endSession(EndSessionInput.new({ session: this.session }));
		await this.inner.shutdown();
		if (this.inner instanceof CuaDriver) this.inner.uniffiDestroy();
	}

	/**
	 * Re-declare the session on a wall-clock schedule, before its 300s lifetime runs out.
	 *
	 * `start_session` is documented idempotent — "re-calling with the same id just refreshes
	 * its idle-TTL" — so the refresh is the same call that opened the session, with no effect
	 * on the app.
	 *
	 * Unconditional on purpose. The obvious optimisation, skipping the refresh when a real
	 * call just happened, is exactly wrong here: the deadline is absolute, so the busiest
	 * possible session expires on the same schedule as an idle one. The first version of
	 * this skipped while busy and would have prevented nothing.
	 */
	private startHeartbeat(): void {
		this.heartbeat = setInterval(() => {
			if (this.closing) return;

			this.heartbeatInFlight = this.inner
				.startSession(StartSessionInput.new({ session: this.session }))
				// Swallowed deliberately: if the driver is genuinely gone, the next real
				// action reports it with a real error. A failed heartbeat is not itself news.
				.catch(() => {});
		}, HEARTBEAT_MS);
		this.heartbeat.unref();
	}

	private dispatch(action: ActionRequest): Promise<ToolResult> {
		const scope = DesktopScope.Desktop;
		const session = this.session;

		switch (action.kind) {
			case "click":
				return this.inner.click(ClickInput.new({
					x: action.x,
					y: action.y,
					scope,
					session,
					button: BUTTONS[action.button ?? "left"],
					count: action.count,
				}));
			case "type":
				return this.inner.typeText(TypeTextInput.new({ text: action.text, scope, session }));
			case "key":
				return this.inner.pressKey(PressKeyInput.new({ key: action.key, scope, session }));
			case "hotkey":
				return this.inner.hotkey(HotkeyInput.new({ keys: action.keys, scope, session }));
			case "scroll":
				return this.inner.scroll(ScrollInput.new({
					x: action.x,
					y: action.y,
					direction: SCROLL_DIRECTIONS[action.direction],
					amount: action.amount === undefined ? undefined : BigInt(action.amount),
					scope,
					session,
				}));
			case "tool":
				return this.inner.callTool(action.name, JSON.stringify({ ...action.args, session }));
		}
	}

	private throwIfError(result: ToolResult, context: string): void {
		if (result.isError)
			throw new Error(`${context} failed (${result.errorCode ?? "unknown"}): ${result.text}`);
	}
}
