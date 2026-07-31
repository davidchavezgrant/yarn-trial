import { execFile } from "node:child_process";

/**
 * macOS keychain equalization — the invisible half of session portability.
 *
 * Chromium (and every Electron app that uses `safeStorage`) encrypts its cookie jar and saved
 * logins with a random key stored in the login keychain under a generic-password item named
 * `<App> Safe Storage`. That key is minted per machine on first launch. So a session bundle
 * copied from box A to box B arrives whole and still fails to open: box B's Chromium reads the
 * moved cookie jar with box B's key, gets garbage, and treats the session as corrupt. The files
 * moved; the key that reads them did not.
 *
 * Two ways to make the bytes portable, and this module is the one for native Electron targets:
 *
 *  - WEB targets never reach here — the fleet's own Chrome launches with `--use-mock-keychain`
 *    (see src/backends/cdp.ts), which replaces the keychain key with a fixed one, so its profile
 *    is portable by construction with no keychain surgery at all.
 *  - APP targets can't be relaunched with a flag we choose, so the answer is to make every box
 *    share the SAME Safe Storage key: read it off the box where the app was first signed in, and
 *    seed the identical generic-password item on the other boxes BEFORE the app's first launch
 *    there. Chromium uses an existing item rather than minting one, so from then on the bundle
 *    opens everywhere.
 *
 * NOTHING HERE IS APP-SPECIFIC beyond the app's own name, which macOS itself uses to name the
 * item — the same hard rule profiles.ts holds. There is no table of known apps.
 *
 * VERIFICATION STATUS: the argv builders and parsers below are unit-tested; the round trip
 * against a real login keychain is NOT — it needs two provisioned Macs and a signed-in Electron
 * app, which no test here has. Treated like every other "typecheck+unit, not yet live" claim in
 * this repo. Caveats that live validation must settle are inline where they bite.
 */

/** The generic-password service name macOS uses for an app's OSCrypt key. */
export function safeStorageService(app: string): string {
	return `${app} Safe Storage`;
}

/**
 * The account under that service. Chromium writes its own product name; most Electron apps do
 * too, so the app name is the right default. Kept a separate function because the one place it
 * is known to differ (a rebranded Chromium) would override here, not at every call site.
 */
export function safeStorageAccount(app: string): string {
	return app;
}

/**
 * argv to READ the Safe Storage secret. `-w` prints only the password. Runs as the console
 * user, so it reads the login keychain the apps write to. No secret in this argv — reading is
 * safe to log; only seeding carries the value.
 */
export function readSecretArgv(app: string): string[] {
	return ["find-generic-password", "-w", "-s", safeStorageService(app), "-a", safeStorageAccount(app)];
}

/**
 * argv to SEED the secret on a box that does not have it. `-U` updates the item in place when it
 * already exists rather than erroring, so re-running is idempotent. `-T ""` grants no
 * application ACL entry: the app itself, on its first launch, prompts the console user once to
 * allow access, which is one click per app per box — deliberately chosen over `-A` (allow every
 * app to read the key unprompted), which would hand any process on the box the cookie-decryption
 * key. That one prompt is the same class of per-provision human click the default-browser grant
 * already accepts.
 *
 * CAVEAT for live validation: `security add-generic-password -w <secret>` puts the secret on a
 * command line, briefly visible to `ps` on that box. The boxes are the fleet's own single-account
 * Macs, so the exposure is small, but a hardened version would feed it another way. Recorded, not
 * yet mitigated.
 */
export function seedSecretArgv(app: string, secret: string): string[] {
	return ["add-generic-password", "-U", "-s", safeStorageService(app), "-a", safeStorageAccount(app), "-w", secret, "-T", ""];
}

/** How a subprocess is run, injected so the argv builders and parsing test offline. */
export type Exec = (bin: string, argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: Exec = (bin, argv) =>
	new Promise((resolve) => {
		execFile(bin, argv, { encoding: "utf8", timeout: 10_000 }, (err, stdout, stderr) => {
			const e = err as (Error & { code?: number | string }) | null;
			resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});

/**
 * Read an app's Safe Storage secret on this machine, or undefined when the item is absent.
 *
 * `security` exits 44 (`errSecItemNotFound`) when nothing matches — the ordinary "this app was
 * never signed in here" answer, returned as undefined rather than thrown. The value is trimmed
 * of the single trailing newline `-w` prints and nothing else, because a keychain secret is
 * opaque bytes and this must not "clean up" one.
 */
export async function readSafeStorage(app: string, exec: Exec = defaultExec): Promise<string | undefined> {
	const res = await exec("security", readSecretArgv(app));
	if (res.code === 0) return res.stdout.replace(/\n$/, "");
	if (res.code === 44) return undefined;
	throw new Error(`security find-generic-password failed (${res.code}): ${res.stderr.trim() || "unknown error"}`);
}

/** Seed (or update) an app's Safe Storage secret on this machine. Idempotent via `-U`. */
export async function seedSafeStorage(app: string, secret: string, exec: Exec = defaultExec): Promise<void> {
	const res = await exec("security", seedSecretArgv(app, secret));
	if (res.code !== 0) throw new Error(`security add-generic-password failed (${res.code}): ${res.stderr.trim() || "unknown error"}`);
}

/**
 * Whether this machine holds a Safe Storage item for the app — the doctor-grade signal that its
 * key has been equalized. Just presence: reading the value to compare across boxes would put the
 * cookie-decryption key on a wire for a health check, which is never worth it.
 */
export async function hasSafeStorage(app: string, exec: Exec = defaultExec): Promise<boolean> {
	return (await readSafeStorage(app, exec)) !== undefined;
}
