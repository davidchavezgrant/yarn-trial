import { Driver } from "./driver.js";
import { assertObservable } from "./harness.js";

function section(title: string, payload: unknown): void {
	console.log(`\n=== ${title} ===`);
	console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
}

/**
 * Smoke test: driver loads, TCC permissions verified, target app launched in
 * the background, and window-scoped perception (AX elements + screenshot)
 * works end to end.
 */
async function main(): Promise<void> {
	const target = process.argv[2] ?? "Linear";
	console.log("starting driver (in-process, no daemon)...");
	const driver = await Driver.start("probe");

	try {
		const permissions = await driver.act({ kind: "tool", name: "check_permissions", args: {} });
		section("check_permissions", permissions.text);

		await driver.act({ kind: "tool", name: "launch_app", args: { name: target } });

		const windows = await driver.act({ kind: "tool", name: "list_windows", args: {} });
		const windowList = JSON.parse(windows.structuredJson ?? "{}");
		section("list_windows structured keys", Object.keys(windowList));

		const entries: any[] = windowList.windows ?? windowList.elements ?? [];
		const area = (w: any) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0);
		const win = entries
			.filter((w) => JSON.stringify(w).toLowerCase().includes(target.toLowerCase()))
			.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || area(b) - area(a))[0];
		if (!win) {
			section("windows dump (no match found)", windows.text.slice(0, 2000));
			return;
		}
		section("target window", win);

		const state = await driver.act({
			kind: "tool",
			name: "get_window_state",
			args: {
				pid: win.pid,
				window_id: win.window_id ?? win.windowId ?? win.id,
				screenshot_out_file: `${process.cwd()}/out/probe-window.png`,
			},
		});
		const structured = JSON.parse(state.structuredJson ?? "{}");
		const elements: any[] = structured.elements ?? [];
		section("element count", String(elements.length));
		section("first 15 elements", elements.slice(0, 15));
		section("markdown tree (first 2500 chars)", state.text.slice(0, 2500));
	} finally {
		await driver.close();
	}
}

main().catch((err) => {
	console.error("probe failed:", err);
	process.exit(1);
});
