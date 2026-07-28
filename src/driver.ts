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
	private inner: CuaDriverLike;
	private session: string;

	private constructor(inner: CuaDriverLike, session: string) {
		this.inner = inner;
		this.session = session;
	}

	static async start(session: string): Promise<Driver> {
		const inner = CuaDriver.create(undefined);
		if (!inner.isAvailable()) throw new Error("cua-driver native library unavailable on this host");

		await inner.startSession(StartSessionInput.new({ session }));

		return new Driver(inner, session);
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
		const result = await this.dispatch(action);
		this.throwIfError(result, action.kind);

		return result;
	}

	async close(): Promise<void> {
		await this.inner.endSession(EndSessionInput.new({ session: this.session }));
		await this.inner.shutdown();
		if (this.inner instanceof CuaDriver) this.inner.uniffiDestroy();
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
