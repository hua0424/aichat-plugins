import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Shared persistence for the node's tiny per-(uid,room) JSON object maps.
 *
 * Four stores used to hand-copy the SAME load/persist/mkdir plumbing — opencode/codex/cc session stores
 * and the bind-token store (whose comment even admitted "Structure mirrors FileCodexSessionStore …").
 * The read/write primitives are single-sourced here; the three session stores additionally share the whole
 * `FileJsonMapStore<T>` (get/set/delete/findKey), while the bind-token store keeps its own dual-map +
 * lowercase-normalization on top of these primitives (it is a distinct security path, not a copy).
 *
 * aichatoverview#166: writes are ASYNC + serialized + mkdir-once ({@link AsyncJsonWriter}) — the per-turn
 * persist no longer blocks the shared event loop. These files are CACHES (session-id / bind-token); a lost
 * in-flight write on a crash only costs one re-derivation. `whenPersisted()` awaits the drained chain for
 * tests / graceful shutdown.
 */

/** Read a JSON object map from disk; `{}` on missing file or parse failure (never throws). */
export function readJsonMap<V>(path: string): Record<string, V> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, V>) : {};
	} catch {
		return {};
	}
}

/**
 * Serialized async JSON writer for one file: `mkdir -p` once, then each `write()` chains a
 * `writeFile` after the previous (last-write-wins ordering preserved) with an optional `chmod`
 * (the bind-token file passes `0o600`). Best-effort: a disk failure is swallowed (never crash the node).
 */
export class AsyncJsonWriter {
	private dirEnsured = false;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly path: string,
		private readonly mode?: number,
	) {}

	/** Queue a whole-object write. Fire-and-forget; ordering is preserved by the internal chain. */
	write(obj: unknown): void {
		const data = JSON.stringify(obj, null, 2);
		this.chain = this.chain.then(() => this.flush(data)).catch(() => {});
	}

	/** Resolve when all queued writes have drained (tests / graceful shutdown). */
	whenWritten(): Promise<void> {
		return this.chain;
	}

	private async flush(data: string): Promise<void> {
		try {
			if (!this.dirEnsured) {
				await mkdir(dirname(this.path), { recursive: true });
				this.dirEnsured = true;
			}
			await writeFile(this.path, data, 'utf-8');
			if (this.mode !== undefined) await chmod(this.path, this.mode);
		} catch {
			/* best-effort: keep the in-memory map even if the disk write fails */
		}
	}
}

/**
 * A file-backed JSON object map `key -> V`: loaded once (sync) on construction, persisted whole on every
 * mutation — but ASYNC + skip-if-unchanged (aichatoverview#166). `validate` field-checks a value on read
 * (a malformed on-disk entry reads back as `undefined` but is left in place, matching the pre-extraction
 * session-store semantics). Read/parse/write failures degrade to an empty/no-op store.
 */
export class FileJsonMapStore<V> {
	private map: Record<string, V>;
	private readonly writer: AsyncJsonWriter;

	constructor(
		private readonly path: string,
		private readonly validate: (v: V) => boolean,
	) {
		this.map = readJsonMap<V>(path);
		this.writer = new AsyncJsonWriter(path);
	}

	get(key: string): V | undefined {
		const v = this.map[key];
		return v !== undefined && this.validate(v) ? v : undefined;
	}

	set(key: string, val: V): void {
		// skip-if-unchanged: a --resume turn re-sets the SAME session id → no map change → no disk write.
		if (key in this.map && sameJson(this.map[key], val)) return;
		this.map[key] = val;
		this.writer.write(this.map);
	}

	delete(key: string): void {
		if (!(key in this.map)) return;
		delete this.map[key];
		this.writer.write(this.map);
	}

	/** Reverse lookup: the first key whose value satisfies `pred`, or undefined. */
	findKey(pred: (v: V) => boolean): string | undefined {
		for (const [key, val] of Object.entries(this.map)) {
			if (val !== undefined && pred(val)) return key;
		}
		return undefined;
	}

	/** Resolve when all queued async persists have drained (tests / graceful shutdown). */
	whenPersisted(): Promise<void> {
		return this.writer.whenWritten();
	}
}

/** Structural equality via canonical JSON (values are tiny flat records: {sessionId} / {threadId} / …). */
function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
