import { Driver } from "./driver.js";

// Usage: tsx step.mts '<json array of {name, args}>' [screenshot-name]
// Finds Notion Calendar's main window, injects pid/window_id into each action,
// runs them in order, then snapshots window state + screenshot.

const APP = "Notion Calendar";
const OUT = `${process.cwd()}/out`;

async function main(): Promise<void> {
	const actions: Array<{ name: string; args: Record<string, unknown> }> =
		process.argv[2] ? JSON.parse(process.argv[2]) : [];
	const shotName = process.argv[3] ?? "step";

	const driver = await Driver.start("demo-tz");

	try {
		const windows = await driver.act({ kind: "tool", name: "list_windows", args: {} });
		const parsed = JSON.parse(windows.structuredJson ?? "{}");
		const area = (w: any) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0);
		const win = (parsed.windows ?? [])
			.filter((w: any) => w.app_name === APP)
			.sort((a: any, b: any) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || area(b) - area(a))[0];
		if (!win) throw new Error(`${APP} window not found — is it running?`);
		console.log(`window: id=${win.window_id} pid=${win.pid} title="${win.title}"`);

		const snapshot = async (): Promise<any[]> => {
			const state = await driver.act({
				kind: "tool",
				name: "get_window_state",
				args: { pid: win.pid, window_id: win.window_id },
			});
			return JSON.parse(state.structuredJson ?? "{}").elements ?? [];
		};

		for (const a of actions as Array<{ name: string; args: Record<string, unknown>; find?: { label?: string; role?: string; nth?: number } }>) {
			const args: Record<string, unknown> = { pid: win.pid, window_id: win.window_id, ...a.args };
			if (a.find) {
				const els = await snapshot();
				const matches = els.filter((e) =>
					(!a.find!.role || e.role === a.find!.role) &&
					(!a.find!.label ||
						`${e.label ?? ""} ${e.value ?? ""}`.toLowerCase().includes(a.find!.label.toLowerCase())),
				);
				const el = matches[a.find.nth ?? 0];
				if (!el) throw new Error(`no element matching ${JSON.stringify(a.find)} (${matches.length} matches)`);
				args.element_index = el.element_index;
				console.log(`\nresolved ${JSON.stringify(a.find)} -> [${el.element_index}] ${el.role} "${el.label ?? ""}"`);
			}
			const res = await driver.act({ kind: "tool", name: a.name, args });
			console.log(`\n>>> ${a.name} ${JSON.stringify({ ...a.args, element_index: args.element_index })}`);
			console.log(res.text.slice(0, 500));
			await new Promise((r) => setTimeout(r, 800));
		}

		const state = await driver.act({
			kind: "tool",
			name: "get_window_state",
			args: {
				pid: win.pid,
				window_id: win.window_id,
				screenshot_out_file: `${OUT}/${shotName}.png`,
			},
		});
		const structured = JSON.parse(state.structuredJson ?? "{}");
		const elements: any[] = structured.elements ?? [];
		console.log(`\n=== ${elements.length} elements (interactive/labeled) ===`);
		for (const e of elements) {
			const label = (e.label ?? e.value ?? "").toString().replace(/\s+/g, " ").slice(0, 90);
			const interesting =
				label ||
				["AXButton", "AXTextField", "AXPopUpButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXComboBox", "AXLink", "AXCell", "AXRow"].includes(e.role);
			if (!interesting) continue;
			const f = e.frame ? `(${e.frame.x},${e.frame.y} ${e.frame.w}x${e.frame.h})` : "";
			console.log(`[${e.element_index}] ${e.role} "${label}" ${f}${e.selected ? " SELECTED" : ""}${e.enabled === false ? " disabled" : ""}`);
		}
		console.log(`\nscreenshot: ${OUT}/${shotName}.png`);
	} finally {
		await driver.close();
	}
}

main().catch((err) => {
	console.error("step failed:", err);
	process.exit(1);
});
