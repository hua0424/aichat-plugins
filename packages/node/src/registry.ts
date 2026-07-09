import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { AICHAT_HOME, type AichatConfig, type AichatCredentials } from './config.js';

/**
 * REQ-008 #76 — 静态 agent 注册表项。
 * 每项描述一个 aiclaw 身份（激活 token + 工具后端），监督器据此拉起一条完整身份链路。
 */
export interface AgentEntry {
	/** 工具后端（'openclaw' | 'opencode' | 'codex' | 'cc'）；凭证解析与 tool 无关，driver 构建按 tool 分派。 */
	tool: string;
	/** aiclaw **激活** token（必填）。 */
	token: string;
	/** opencode 项目根目录（本切片未用，透传）。 */
	cwd?: string;
	/** 模型覆盖（本切片未用，透传）。 */
	model?: string;
}

/**
 * 从 config.agents 读取并校验注册表。
 * 缺省返回 []；逐项校验 token / tool 非空字符串，非法项跳过 + 警告（不抛）。
 */
export function loadAgentRegistry(config: AichatConfig): AgentEntry[] {
	const raw = config.agents;
	if (!Array.isArray(raw)) return [];

	const valid: AgentEntry[] = [];
	const seenTokens = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i] as Partial<AgentEntry> | undefined;
		if (!entry || typeof entry !== 'object') {
			console.warn(`[registry] skipping invalid agent entry #${i}: not an object`);
			continue;
		}
		if (typeof entry.token !== 'string' || entry.token.trim() === '') {
			console.warn(`[registry] skipping invalid agent entry #${i}: missing/empty 'token'`);
			continue;
		}
		if (typeof entry.tool !== 'string' || entry.tool.trim() === '') {
			console.warn(`[registry] skipping invalid agent entry #${i}: missing/empty 'tool'`);
			continue;
		}
		// 去重：同一 aiclaw 激活 token 配置了两次 → 跳过重复项（保留首次出现），不抛。
		if (seenTokens.has(entry.token)) {
			console.warn(
				`[registry] skipping duplicate agent entry #${i}: token already configured by an earlier entry (keeping the first occurrence)`,
			);
			continue;
		}
		seenTokens.add(entry.token);
		valid.push({
			tool: entry.tool,
			token: entry.token,
			...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
			...(entry.model !== undefined ? { model: entry.model } : {}),
		});
	}
	return valid;
}

/**
 * 解析单身份凭证选项。
 */
export interface ResolveCredentialOpts {
	/** 本机机器码（绑定时上送）。 */
	machineCode: string;
	/** server HTTP base，如 http://host:port/api（不含 /im/aiclaw/...）。 */
	httpBase: string;
	/** 凭证缓存目录；缺省 `${AICHAT_HOME}/credentials`。 */
	credentialsDir?: string;
	/** 可注入 fetch（测试用）。 */
	fetchImpl?: typeof fetch;
}

/**
 * server activate 响应 envelope。
 */
interface ActivateResponse {
	success: boolean;
	/**
	 * SERVER CONTRACT：server 把 Java `Long` uid 序列化为 **字符串**（如 "163589881742848"）。
	 * REQ-029 (#29)：调用方一律 `String()` 化为不透明字符串（防 >2^53 精度丢失），绝不 Number() 收敛。
	 */
	data?: { uid: number | string; connectionToken: string };
	msg?: string;
}

/**
 * 每身份凭证缓存文件路径 = `${dir}/${sha256(token).slice(0,16)}.jsonc`。
 */
export function cacheFilePath(token: string, dir: string): string {
	const hash = createHash('sha256').update(token).digest('hex').slice(0, 16);
	return join(dir, `${hash}.jsonc`);
}

/**
 * 解析为合法 AichatCredentials（含 uid / connectionToken / machineCode）则返回，否则 null。
 */
function readCachedCredential(path: string): AichatCredentials | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, 'utf-8');
		const json = raw.replace(/^\s*\/\/.*$/gm, '');
		const parsed = JSON.parse(json) as { uid?: unknown; connectionToken?: unknown; machineCode?: unknown; activatedAt?: unknown };
		// REQ-029 (#29)：uid 一律**不透明字符串**。缓存文件可能是字符串 uid（新写入）或旧版数字 uid
		// （backward-compat：早期 Number() 收敛落盘）——两者都 String() 归一，绝不 Number() 化
		// （>2^53 会精度丢失）。校验为非空纯数字串且非 '0'。
		const uid =
			typeof parsed.uid === 'number'
				? String(parsed.uid)
				: typeof parsed.uid === 'string'
					? parsed.uid
					: undefined;
		if (
			typeof uid === 'string' &&
			/^\d+$/.test(uid) &&
			uid !== '0' &&
			typeof parsed.connectionToken === 'string' &&
			parsed.connectionToken !== '' &&
			typeof parsed.machineCode === 'string' &&
			parsed.machineCode !== ''
		) {
			return { ...parsed, uid } as AichatCredentials;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 解析单身份凭证（per-identity）。
 *
 * SERVER CONTRACT：activate 非幂等——已激活的 aiclaw 再次 activate 会抛「该AI助理已激活」。
 * 因此：缓存命中即复用、绝不重激活；仅缓存缺失（首次）时才打一次 activate 网络请求并落盘。
 *
 * - 缓存命中且解析为合法凭证 → 直接返回，**不**发网络请求。
 * - 缓存缺失 → POST `${httpBase}/im/aiclaw/anyTenant/activate` {activationToken, machineCode}；
 *   成功（success:true, data:{uid, connectionToken}）→ 构造凭证、mkdir -p 落盘、返回；
 *   失败（success:false / 网络错误 / HTTP 错误）→ 抛 Error（带 server msg），由监督器降级本身份。
 */
export async function resolveAgentCredential(
	entry: AgentEntry,
	opts: ResolveCredentialOpts,
): Promise<AichatCredentials> {
	const dir = opts.credentialsDir ?? join(AICHAT_HOME, 'credentials');
	const path = cacheFilePath(entry.token, dir);

	// 1. 缓存命中：复用，绝不重激活
	const cached = readCachedCredential(path);
	if (cached) {
		return cached;
	}

	// 2. 缓存缺失：首次激活（绑定 machineCode + 翻转 auth_status）
	const fetchImpl = opts.fetchImpl ?? fetch;
	const url = `${opts.httpBase.replace(/\/+$/, '')}/im/aiclaw/anyTenant/activate`;

	let result: ActivateResponse;
	try {
		const resp = await fetchImpl(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ activationToken: entry.token, machineCode: opts.machineCode }),
		});
		result = (await resp.json()) as ActivateResponse;
	} catch (err) {
		throw new Error(`activate request failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!result.success || !result.data) {
		// REQ-008 #76（manager 硬约束）：activate 非幂等 + 激活后激活码不可再查（明文已弃）。
		// 若 server 报「已激活」而本机又无缓存凭证，则该身份**不可恢复**：既不能重激活、也取不回
		// connectionToken。明确告知用户须重建一个新 aiclaw（而非误以为是临时网络/配置问题可重试）。
		const msg = result.msg || 'activation failed';
		if (msg.includes('已激活')) {
			throw new Error(
				`该 aiclaw 已激活但本机无缓存凭证（${path}）——激活码不可恢复、无法重激活，此身份不可恢复，请重建一个新 aiclaw 并用新激活码替换注册表项。（server: ${msg}）`,
			);
		}
		throw new Error(msg);
	}

	const credential: AichatCredentials = {
		// SERVER CONTRACT：server 把 Long uid 序列化为字符串（如 "163589881742848"）。
		// REQ-029 (#29)：一律 String() 归一为**不透明字符串**落盘，绝不 Number() 化
		// （>2^53 精度丢失会让 Map key 碰撞、路由错乱）；readCachedCredential 同样按字符串校验/回读。
		uid: String(result.data.uid),
		connectionToken: result.data.connectionToken,
		machineCode: opts.machineCode,
		activatedAt: new Date().toISOString(),
	};

	// 落盘缓存（mkdir -p），后续启动走缓存命中、不再激活
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(credential, null, 2), 'utf-8');

	return credential;
}
