import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeRef } from '../events.js';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (ref: NativeRef) => {
	if (!ref.sessionId || !ref.turnId) throw new Error('CODEX_NATIVE_TURN_REQUIRED');
	return digest(JSON.stringify([ref.sessionId, ref.turnId]));
};

// Loaded bytes, not a second require(path), are evaluated after hashing: no check/use race.
export const GRANT_BOOTSTRAP = `try{const f=require('node:fs'),c=f.readFileSync(process.argv[1]);if(require('node:crypto').createHash('sha256').update(c).digest('hex')!==process.argv[2])throw 0;new Function('require','process',c.toString('utf8'))(require,process)}catch{process.stderr.write('CODEX_HOOK_INTEGRITY_FAILED\\n');process.exit(2)}`;

/** The caller still owns its published grant when both cleanup and exact rollback fail. */
export class CodexGrantPublicationError extends Error {
	constructor() { super('CODEX_GRANT_ROLLBACK_UNCONFIRMED'); }
}

/** Private to this app-server lifetime. No shared current-turn pointer and no workspace writes. */
export class CodexTurnGrants {
	readonly helper: string;
	readonly helperHash: string;
	private readonly granted = new Set<string>();
	private closed = false;
	private disposed = false;
	private constructor(readonly directory: string, helper: string, helperHash: string) { this.helper = helper; this.helperHash = helperHash; }
	static async create(): Promise<CodexTurnGrants> {
		const directory = await mkdtemp(join(tmpdir(), 'aichat-codex-turn-'));
		await chmod(directory, 0o700);
		const helper = join(directory, 'pre-tool.cjs');
		const source = `
const fs=require('node:fs'),crypto=require('node:crypto');
const root=${JSON.stringify(directory.split(sep).join('/'))};
const q=s=>"'"+s.replaceAll("'","'\\\\''")+"'";
let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',part=>{input+=part;if(input.length>262144)deny()});
function deny(){process.stderr.write('CODEX_TURN_GRANT_UNAVAILABLE\\n');process.exit(2)}
process.stdin.on('end',async()=>{try{
 const p=JSON.parse(input);
 if(p.hook_event_name!=='PreToolUse'||typeof p.session_id!=='string'||!p.session_id||typeof p.turn_id!=='string'||!p.turn_id||typeof p.tool_input?.command!=='string')return deny();
 const k=crypto.createHash('sha256').update(JSON.stringify([p.session_id,p.turn_id])).digest('hex');
 const env=root+'/'+k+'.env',revoked=root+'/'+k+'.revoked',closed=root+'/.closed';
 const unavailable=()=>fs.existsSync(revoked)||fs.existsSync(closed);
 const deadline=Date.now()+10000;
 while(!fs.existsSync(env)){if(unavailable()||Date.now()>=deadline)return deny();await new Promise(r=>setTimeout(r,10))}
 if(unavailable())return deny();
 const command='. '+q(env)+' && test ! -e '+q(revoked)+' && test ! -e '+q(closed)+' && eval '+q(p.tool_input.command);
 process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command}}})+'\\n');
}catch{deny()}});
`;
		await writeFile(helper, source, { flag: 'wx', mode: 0o400 });
		return new CodexTurnGrants(directory, helper, digest(source));
	}

	/** Native config's trusted_hash fingerprints command text. This separately pins helper bytes. */
	command(node = process.execPath): string {
		return [node, '-e', GRANT_BOOTSTRAP, this.helper, this.helperHash].map(quote).join(' ');
	}

	async grant(ref: NativeRef, token: string): Promise<void> {
		if (this.closed) throw new Error('CODEX_TURN_GRANTS_CLOSED');
		if (!token || token.length > 256) throw new Error('CODEX_INVALID_TURN_GRANT');
		const id = key(ref);
		const file = join(this.directory, `${id}.env`), temporary = join(this.directory, `${randomUUID()}.pending`);
		const value = `export AICHAT_RUN_BIND=${quote(token)}\n`;
		await writeFile(temporary, value, { flag: 'wx', mode: 0o400 });
		let published = false;
		try {
			// link is an atomic publish-without-replacement; readers never see half-written bytes.
			await link(temporary, file);
			published = true;
			this.granted.add(id);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== value)
				throw new Error('CODEX_TURN_GRANT_CONFLICT');
		} finally {
			try { await unlink(temporary); }
			catch (error) {
				// A rejected grant must not silently leave this call's publication live. Never revoke EEXIST's owner.
				if (published) {
					try { await this.tombstone(id); }
					catch { throw new CodexGrantPublicationError(); }
				}
				throw error;
			}
		}
		this.granted.add(id);
	}
	async revoke(ref: NativeRef): Promise<void> { await this.tombstone(key(ref)); }
	private async tombstone(id: string): Promise<void> {
		try { await writeFile(join(this.directory, `${id}.revoked`), '', { flag: 'wx', mode: 0o400 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	}
	async revokeAll(): Promise<void> {
		this.closed = true;
		try { await writeFile(join(this.directory, '.closed'), '', { flag: 'wx', mode: 0o400 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
		await Promise.all([...this.granted].map((id) => this.tombstone(id)));
	}
	/** Only this instance's mkdtemp directory; no workspace/native history is removed. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.closed = true;
		try { await this.revokeAll(); }
		finally {
			await rm(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
			this.disposed = true;
		}
	}
}

// Native 0.142.3 fingerprint::version_for_toml: recursively sorted, compact JSON SHA256.
export function codexHookConfig(command: string): Record<string, unknown> {
	const handler = { type: 'command', command, timeout: 15, async: false };
	const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
		? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => [name, sorted(child)])) : value;
	const hash = `sha256:${digest(JSON.stringify(sorted({ event_name: 'pre_tool_use', matcher: 'Bash', hooks: [handler] })))}`;
	return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [handler] }], state: {
		'/<session-flags>/config.toml:pre_tool_use:0:0': { enabled: true, trusted_hash: hash },
	} } };
}
