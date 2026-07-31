import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { packArgv, packDir, unpackArgv, unpackInto } from "../src/remote/runner/tarball.js";

/** The tar wrapper, against the real `tar` on this machine. */

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tarball-test-"));
}

test("packArgv__PacksContentsRelative__When__GivenADir", () => {
	assert.deepEqual(packArgv("/src", "/out.tgz"), ["-czf", "/out.tgz", "-C", "/src", "."]);
	assert.deepEqual(unpackArgv("/in.tgz", "/dst"), ["-xzf", "/in.tgz", "-C", "/dst"]);
});

test("packDir__then__unpackInto__RoundTripsANestedTree", async () => {
	const src = tmp();
	fs.mkdirSync(path.join(src, "Library/App"), { recursive: true });
	fs.writeFileSync(path.join(src, "Library/App/cookies"), "jar");
	fs.writeFileSync(path.join(src, "manifest.json"), '{"paths":["Library/App"]}');

	const out = path.join(tmp(), "b.tar.gz");
	const bytes = await packDir(src, out);
	assert.ok(bytes > 0);

	const dst = path.join(tmp(), "restored");
	await unpackInto(out, dst);
	assert.equal(fs.readFileSync(path.join(dst, "Library/App/cookies"), "utf8"), "jar");
	assert.equal(fs.readFileSync(path.join(dst, "manifest.json"), "utf8"), '{"paths":["Library/App"]}');
});

test("unpackInto__Replaces__RatherThanMerges", async () => {
	const src = tmp();
	fs.writeFileSync(path.join(src, "keep"), "new");
	const out = path.join(tmp(), "b.tar.gz");
	await packDir(src, out);

	const dst = tmp();
	fs.writeFileSync(path.join(dst, "stale"), "old"); // a file NOT in the bundle
	await unpackInto(out, dst);

	assert.ok(fs.existsSync(path.join(dst, "keep")));
	assert.ok(!fs.existsSync(path.join(dst, "stale")), "a path no longer in the bundle must not survive the restore");
});
