import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Shared persistence for the node's tiny per-(uid,room) JSON object maps.
 *
 * Four stores used to hand-copy the SAME load/persist/mkdir plumbing — opencode/codex/cc session stores
 * and the bind-token store (whose comment even admitted "Structure mirrors FileCodexSessionStore …").
 * The read/write primitives are single-sourced here; the three session stores additionally share the whole
 * `FileJsonMapStore<T>` (get/set/delete/findKey), while the bind-token store keeps its own dual-map +
 * lowercase-normalization on top of these primitives (it is a distinct security path, not a copy).
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
 * Write a JSON object map to disk: `mkdir -p` the dir, write pretty JSON, then optionally `chmod` it
 * (the bind-token file passes `0o600` — it grants capability identity). Best-effort: a disk failure is
 * swallowed so the in-memory map still serves (never crash the node).
 */
export function writeJsonMap(path: string, obj: unknown, mode?: number): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8');
		if (mode !== undefined) chmodSync(path, mode);
	} catch {
		/* best-effort: keep the in-memory map even if the disk write fails */
	}
}

/**
 * A file-backed JSON object map `key -> V`: loaded once on construction, persisted whole on every
 * mutation (the maps are small — one entry per (aiclawUid, roomId) pair). `validate` field-checks a
 * value on read (a malformed on-disk entry reads back as `undefined` but is left in place, matching the
 * pre-extraction session-store semantics). Read/parse/write failures degrade to an empty/no-op store.
 */
export class FileJsonMapStore<V> {
	private map: Record<string, V>;

	constructor(
		private readonly path: string,
		private readonly validate: (v: V) => boolean,
	) {
		this.map = readJsonMap<V>(path);
	}

	get(key: string): V | undefined {
		const v = this.map[key];
		return v !== undefined && this.validate(v) ? v : undefined;
	}

	set(key: string, val: V): void {
		this.map[key] = val;
		writeJsonMap(this.path, this.map);
	}

	delete(key: string): void {
		if (!(key in this.map)) return;
		delete this.map[key];
		writeJsonMap(this.path, this.map);
	}

	/** Reverse lookup: the first key whose value satisfies `pred`, or undefined. */
	findKey(pred: (v: V) => boolean): string | undefined {
		for (const [key, val] of Object.entries(this.map)) {
			if (val !== undefined && pred(val)) return key;
		}
		return undefined;
	}
}
