export interface Observation {
	text: string;
	screenshotPath?: string;
	structured?: unknown;
	degraded: boolean;
}

export type ActionRequest =
	| { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle"; count?: number }
	| { kind: "type"; text: string }
	| { kind: "key"; key: string }
	| { kind: "hotkey"; keys: string[] }
	| { kind: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number }
	| { kind: "tool"; name: string; args: Record<string, unknown> };

export interface Expectation {
	description: string;
	textIncludes?: string[];
	textExcludes?: string[];
}

export interface StepRecord {
	index: number;
	timestamp: string;
	action: ActionRequest;
	expectation: Expectation;
	verified: boolean;
	verificationNote: string;
	screenshotFile?: string;
	modelReasoning?: string;
}

export interface AppMapState {
	id: string;
	title: string;
	fingerprint: string;
	screenshotFile?: string;
}

export interface AppMapEdge {
	from: string;
	action: string;
	to: string;
}

export interface AppMap {
	app: string;
	capturedAt: string;
	states: AppMapState[];
	edges: AppMapEdge[];
}
