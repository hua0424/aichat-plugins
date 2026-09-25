import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** Legacy JSON object map. A missing file is new; an unreadable/corrupt file must not be replaced. */
export function readJsonMap<V>(path: string): Record<string, V> {
	let data: string;
	try {
		data = readFileSync(path, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw err;
	}
	const parsed: unknown = JSON.parse(data);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid JSON map: ${path}`);
	return parsed as Record<string, V>;
}

/** One serial writer per state file; snapshots are staged beside the target and atomically replaced. */
export class AsyncJsonWriter {
	private dirEnsured = false;
	private chain: Promise<void> = Promise.resolve();
	private error: unknown;

	constructor(private readonly path: string, private readonly mode?: number) {}

	write(obj: unknown): void {
		const data = JSON.stringify(obj, null, 2);
		this.chain = this.chain.then(async () => {
			try {
				await this.flush(data);
				this.error = undefined;
			} catch (err) {
				this.error = err;
				console.error(`[store] persist failed (${this.path}):`, err);
			}
		});
	}

	/** Wait for all writes queued so far; surface a failed final snapshot to shutdown/callers. */
	async whenWritten(): Promise<void> {
		await this.chain;
		if (this.error) throw this.error;
	}

	private async flush(data: string): Promise<void> {
		if (!this.dirEnsured) {
			await mkdir(dirname(this.path), { recursive: true });
			this.dirEnsured = true;
		}
		const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, data, { encoding: 'utf-8', mode: this.mode ?? 0o600, flag: 'wx' });
			await rename(temp, this.path);
		} catch (err) {
			await unlink(temp).catch(() => {});
			throw err;
		}
	}
}

/** File-backed legacy key→value map; construction never silently discards broken persisted state. */
export class FileJsonMapStore<V> {
	private map: Record<string, V>;
	private readonly writer: AsyncJsonWriter;

	constructor(path: string, private readonly validate: (v: V) => boolean) {
		this.map = readJsonMap<V>(path);
		this.writer = new AsyncJsonWriter(path);
	}

	get(key: string): V | undefined {
		const v = this.map[key];
		return v != null && this.validate(v) ? v : undefined;
	}

	set(key: string, val: V): void {
		if (key in this.map && sameJson(this.map[key], val)) return;
		this.map[key] = val;
		this.writer.write(this.map);
	}

	delete(key: string): void {
		if (!(key in this.map)) return;
		delete this.map[key];
		this.writer.write(this.map);
	}

	findKey(pred: (v: V) => boolean): string | undefined {
		let found: string | undefined;
		for (const [key, val] of Object.entries(this.map)) {
			if (val != null && pred(val)) {
				if (found) return undefined; // ambiguous native alias must not select the first room
				found = key;
			}
		}
		return found;
	}

	whenPersisted(): Promise<void> {
		return this.writer.whenWritten();
	}
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
