import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appmapsDir, appSlug, dataRoot, nativeDir, outDir, recipesDir, relToData, resourcesRoot } from "../src/paths.js";

/**
 * The contract these tests defend is "no behaviour change in a checkout". paths.ts exists to
 * fix two deployments where cwd is `/`, and the way that refactor goes wrong is by quietly
 * relocating everything for the deployment that already worked.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("dataRoot__ResolvesToCheckout__When__NoOverrideIsSet", () => {
	withEnv({ YARN_RUNNER_DATA: undefined, YARN_RUNNER_RESOURCES: undefined }, () => {
		assert.equal(dataRoot(), REPO);
		assert.equal(resourcesRoot(), REPO);
	});
});

test("outDir__MatchesLegacyCwdPath__When__RunningFromCheckout", () => {
	withEnv({ YARN_RUNNER_DATA: undefined }, () => {
		// These four are verbatim what the code built from process.cwd() before the refactor.
		assert.equal(outDir(), `${REPO}/out`);
		assert.equal(appmapsDir(), `${REPO}/docs/appmaps`);
		assert.equal(recipesDir(), `${REPO}/docs/recipes`);
		assert.equal(nativeDir(), `${REPO}/native`);
	});
});

test("outDir__IgnoresCwd__When__ProcessIsStartedElsewhere", () => {
	// The launchd case: cwd is `/`, but the module still knows where it lives. Asserted by
	// chdir rather than by inspection, because cwd-independence is the entire point.
	const prev = process.cwd();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paths-cwd-"));
	try {
		process.chdir(tmp);
		withEnv({ YARN_RUNNER_DATA: undefined }, () => {
			assert.equal(outDir(), `${REPO}/out`);
		});
	} finally {
		process.chdir(prev);
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("dataRoot__UsesOverride__When__EnvVarIsSet", () => {
	withEnv({ YARN_RUNNER_DATA: "/tmp/somewhere", YARN_RUNNER_RESOURCES: undefined }, () => {
		assert.equal(dataRoot(), "/tmp/somewhere");
		assert.equal(outDir(), "/tmp/somewhere/out");
		// Writable and read-only roots move independently: a packaged app relocates data to
		// userData while resources stay in the bundle.
		assert.equal(resourcesRoot(), REPO);
		assert.equal(recipesDir(), `${REPO}/docs/recipes`);
	});
});

test("relToData__StripsRootPrefix__When__PathIsInsideDataRoot", () => {
	withEnv({ YARN_RUNNER_DATA: "/tmp/root" }, () => {
		assert.equal(relToData("/tmp/root/out/recording/x/window.mp4"), "out/recording/x/window.mp4");
	});
});

test("relToData__ReturnsInputUnchanged__When__PathIsOutsideDataRoot", () => {
	withEnv({ YARN_RUNNER_DATA: "/tmp/root" }, () => {
		assert.equal(relToData("/elsewhere/window.mp4"), "/elsewhere/window.mp4");
	});
});

test("appSlug__FoldsPathSeparators__When__AppNameContainsSlash", () => {
	// The slug is a single path component. A separator surviving into it turns every
	// per-app artifact path into a write under a directory that does not exist — or, with
	// enough dots, into one that escapes the data root.
	assert.equal(appSlug("A/V Recorder"), "a-v-recorder");
	assert.equal(appSlug("C:\\Legacy App"), "c-legacy-app");
	assert.equal(appSlug("../../etc/passwd"), "..-..-etc-passwd");
	// The names every existing artifact is filed under stay put.
	assert.equal(appSlug("Notion Calendar"), "notion-calendar");
});
