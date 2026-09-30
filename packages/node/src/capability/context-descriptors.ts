/** Agent execution environment transports; values are opaque native aliases, not SDK credentials. */
export const contextDescriptors = [
	{ env: 'OPENCODE_SESSION_ID', provider: 'opencode' },
	{ env: 'CODEX_THREAD_ID', provider: 'codex' },
	{ env: 'OPENCLAW_BIND', provider: 'openclaw' },
	{ env: 'AICHAT_BIND', provider: 'cc' },
] as const;
