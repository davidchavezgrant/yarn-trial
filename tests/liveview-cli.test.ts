import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLiveviewArgs, resolveTransport } from "../src/remote/liveview-cli.js";

// ---- parseLiveviewArgs: the command line as data ------------------------------------------
// Pure on purpose: argv and env come in as arguments, so the transport precedence
// (flag > env > auto) is provable without spawning a process or touching real sockets.

test("parseLiveviewArgs__DefaultsToAuto__When__NothingChoosesATransport", () => {
	const args = parseLiveviewArgs([], {});
	assert.equal(args.transport, "auto");
	assert.equal(args.endpoint, undefined);
	assert.equal(args.error, undefined);
});

test("parseLiveviewArgs__ForcesCdp__When__TheBareFlagIsGiven", () => {
	const args = parseLiveviewArgs(["--cdp"], {});
	assert.equal(args.transport, "cdp");
	// Bare flag: no endpoint named — the CDP_PORT default applies at connect time.
	assert.equal(args.endpoint, undefined);
});

test("parseLiveviewArgs__CarriesTheEndpoint__When__TheCdpFlagNamesOne", () => {
	const spaced = parseLiveviewArgs(["--cdp", "http://127.0.0.1:9223"], {});
	assert.equal(spaced.transport, "cdp");
	assert.equal(spaced.endpoint, "http://127.0.0.1:9223");
	// The consumed url must never read as the <mac> positional.
	assert.equal(spaced.mac, undefined);

	const eq = parseLiveviewArgs(["--cdp=http://127.0.0.1:9224"], {});
	assert.equal(eq.transport, "cdp");
	assert.equal(eq.endpoint, "http://127.0.0.1:9224");
});

test("parseLiveviewArgs__KeepsTheHostPositional__When__TheCdpValueIsNotAUrl", () => {
	// The --cdp value is optional, so only a token that reads as an endpoint is consumed:
	// `--cdp mac1 Yarn` is a fleet run forcing cdp, not an endpoint named "mac1".
	const args = parseLiveviewArgs(["--cdp", "mac1", "Yarn"], {});
	assert.equal(args.transport, "cdp");
	assert.equal(args.endpoint, undefined);
	assert.equal(args.mac, "mac1");
	assert.equal(args.app, "Yarn");
});

test("parseLiveviewArgs__ForcesSck__When__TheSckFlagIsGiven", () => {
	assert.equal(parseLiveviewArgs(["--sck"], {}).transport, "sck");
});

test("parseLiveviewArgs__PrefersTheFlag__When__TheEnvDisagrees", () => {
	assert.equal(parseLiveviewArgs(["--cdp"], { LIVEVIEW_TRANSPORT: "sck" }).transport, "cdp");
	assert.equal(parseLiveviewArgs(["--sck"], { LIVEVIEW_TRANSPORT: "cdp" }).transport, "sck");
});

test("parseLiveviewArgs__ReadsTheEnv__When__NoFlagChooses", () => {
	const args = parseLiveviewArgs([], { LIVEVIEW_TRANSPORT: "cdp", LIVEVIEW_CDP_URL: "http://127.0.0.1:9229" });
	assert.equal(args.transport, "cdp");
	assert.equal(args.endpoint, "http://127.0.0.1:9229");
	assert.equal(parseLiveviewArgs([], { LIVEVIEW_TRANSPORT: "sck" }).transport, "sck");
	assert.equal(parseLiveviewArgs([], { LIVEVIEW_TRANSPORT: "auto" }).transport, "auto");
});

test("parseLiveviewArgs__PrefersTheFlagEndpoint__When__TheEnvNamesOneToo", () => {
	const args = parseLiveviewArgs(["--cdp", "http://flag:1"], { LIVEVIEW_CDP_URL: "http://env:2" });
	assert.equal(args.endpoint, "http://flag:1");
});

test("parseLiveviewArgs__Refuses__When__BothTransportFlagsAreGiven", () => {
	const args = parseLiveviewArgs(["--cdp", "--sck"], {});
	assert.match(String(args.error), /mutually exclusive/);
});

test("parseLiveviewArgs__Refuses__When__TheEnvValueIsOutsideTheVocabulary", () => {
	const args = parseLiveviewArgs([], { LIVEVIEW_TRANSPORT: "webrtc" });
	assert.match(String(args.error), /expected auto, cdp or sck/);
});

test("parseLiveviewArgs__KeepsPositionalsAndFlagValuesApart__When__ValuesFollowFlags", () => {
	// A value-taking flag's value must never leak into the positionals — `--fps 30` used to
	// put "30" where the <mac> name goes on a local run.
	const args = parseLiveviewArgs(["mac1", "Yarn", "--fps", "30", "--cdp", "http://127.0.0.1:9229", "--lan"], {});
	assert.equal(args.mac, "mac1");
	assert.equal(args.app, "Yarn");
	assert.equal(args.fps, 30);
	assert.equal(args.lan, true);
	assert.equal(args.endpoint, "http://127.0.0.1:9229");
});

// ---- resolveTransport: requested choice -> the engine that runs ---------------------------
// AUTO is the only state that probes, and the probe is injected, so selection is testable
// without a live debug endpoint. Forced choices never probe: a dead endpoint under --cdp
// must surface the cdp-unreachable remedy, not quietly become window capture.

test("resolveTransport__PicksCdp__When__TheAutoProbeAnswers", async () => {
	const probed: string[] = [];
	const r = await resolveTransport("auto", "http://127.0.0.1:9222", async (e) => {
		probed.push(e);

		return true;
	});
	assert.equal(r.engine, "cdp");
	assert.deepEqual(probed, ["http://127.0.0.1:9222"]);
});

test("resolveTransport__FallsBackToSck__When__TheAutoProbeIsSilent", async () => {
	const r = await resolveTransport("auto", "http://127.0.0.1:9222", async () => false);
	assert.equal(r.engine, "sck");
	// The one log line owed to the operator says why, since the choice changes what the
	// teammate sees.
	assert.match(r.why, /nothing answered at http:\/\/127\.0\.0\.1:9222/);
});

test("resolveTransport__NeverProbes__When__TheChoiceIsForced", async () => {
	let probes = 0;
	const probe = async () => {
		probes++;

		return false;
	};
	assert.equal((await resolveTransport("cdp", "http://127.0.0.1:9222", probe)).engine, "cdp");
	assert.equal((await resolveTransport("sck", "http://127.0.0.1:9222", probe)).engine, "sck");
	assert.equal(probes, 0, "a forced transport must not consult the endpoint");
});
