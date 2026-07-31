import { pathToFileURL } from "node:url";
import { hasSafeStorage, readSafeStorage, seedSafeStorage } from "./keychain.js";

/**
 * The manual handle on macOS keychain equalization (src/remote/keychain.ts) — run ON a fleet Mac,
 * to make an Electron app's encrypted session portable between boxes.
 *
 * The web path needs none of this (`--use-mock-keychain` in cdp.ts makes web profiles portable by
 * construction). This is only for a native/Electron target whose session lives in the Chromium
 * cookie jar, which OSCrypt encrypts with a per-machine key: without an equal key on every box, a
 * moved session bundle arrives unreadable. The procedure, once per such app:
 *
 *   1. On the box where the app is signed in:   ./run keychain export "Yarn"   > key.txt
 *   2. On every OTHER box, before its first launch of the app:
 *          ./run keychain seed "Yarn" < key.txt
 *   3. Check on each box:                         ./run keychain check "Yarn"
 *   4. Delete key.txt.
 *
 * VERIFICATION STATUS: unit-tested (argv + parse), not yet live — it needs two Macs and a
 * signed-in Electron app. Two caveats live validation must settle are in keychain.ts: the secret
 * is briefly visible to `ps` during `seed` (security takes `-w` on the command line), and the app
 * prompts the console user once on first launch to allow reading the seeded item.
 *
 * `export` prints a decryption key to stdout — sensitive by nature. It is deliberately a separate,
 * explicit verb from `check`, which only reports presence, so the key is never printed by accident.
 */

const USAGE = `usage: keychain <check|export|seed> "<App Name>"

  check "<App>"    say whether this Mac holds the app's Safe Storage key (does NOT print it)
  export "<App>"   print the key to stdout — sensitive; pipe it, do not leave it lying around
  seed "<App>"     read a key from stdin and store it here (before the app's first launch)`;

function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (data += c));
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

async function main(argv: string[]): Promise<number> {
	const [verb, app] = argv;
	if (!verb || !app?.trim()) {
		console.error(USAGE);

		return 2;
	}

	if (verb === "check") {
		const present = await hasSafeStorage(app);
		console.log(present ? `✓ ${app} Safe Storage key present on this Mac` : `✗ no ${app} Safe Storage key here — seed it, or this box will sign the app in fresh`);

		return present ? 0 : 1;
	}

	if (verb === "export") {
		const secret = await readSafeStorage(app);
		if (secret === undefined) {
			console.error(`no ${app} Safe Storage key on this Mac — sign the app in here first`);

			return 1;
		}
		process.stdout.write(secret);

		return 0;
	}

	if (verb === "seed") {
		const secret = (await readStdin()).replace(/\n$/, "");
		if (!secret) {
			console.error("no key on stdin — pipe the output of `keychain export` from the source box");

			return 2;
		}
		await seedSafeStorage(app, secret);
		console.log(`✓ seeded ${app} Safe Storage key on this Mac`);

		return 0;
	}

	console.error(USAGE);

	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`keychain failed: ${(err as Error).message}`);
			process.exit(1);
		},
	);
