import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import register from './index.js';
import type { BeforePromptBuildCtx, OpenClawPluginApi, PluginJsonValue } from './types.js';

it('denies a terminal run before host cleanup without losing discovery after a duplicate terminal', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'aichat-claw-terminal-'));
 vi.stubEnv('AICHAT_OPENCLAW_RUNBIND_DIR', dir);
 try {
  const records = new Map<string, PluginJsonValue>();
  const closed = new Set<string>();
  type Terminal = (event: { runId: string; stream: string; data: Record<string, unknown> }, ctx?: {
   setRunContext: (namespace: string, value: PluginJsonValue) => void;
  }) => void;
  let terminal: Terminal | undefined;
  let prompt: ((event: unknown, ctx?: BeforePromptBuildCtx) => Promise<void>) | undefined;
  let gateway: Parameters<NonNullable<OpenClawPluginApi['registerGatewayMethod']>>[1] | undefined;
  const log = vi.fn();
  register({
   logger: { info: log, warn: log, error: log, debug: log }, registerChannel: vi.fn(),
   on: (event, handler) => { if (event === 'before_prompt_build') prompt = handler as typeof prompt; },
   runContext: {
    getRunContext: ({ runId }) => records.get(runId),
    setRunContext: ({ runId, value }) => {
     if (closed.has(runId)) return false;
     records.set(runId, value);
     return true;
    },
   },
   agent: { events: { registerAgentEventSubscription: ({ handle }) => { terminal = handle; } } },
   registerGatewayMethod: (method, handler, opts) => {
    expect(method).toBe('aichat.gatewayContext');
    expect(opts).toEqual({ scope: 'operator.read' });
    gateway = handler;
   },
  });
  if (!terminal || !prompt || !gateway) throw new Error('Expected SDK registrations');
  const rpc = (params: Record<string, unknown>) => {
   const respond = vi.fn();
   gateway({ params, respond });
   expect(respond).toHaveBeenCalledOnce();
   expect(respond.mock.calls[0][0]).toBe(true);
   return respond.mock.calls[0][1];
  };
  const { stamp } = rpc({ kind: 'observer' });
  const owner = (nativeRunId: string) => ({ nativeRunId, runId: `request-${nativeRunId}`, conversationId: 'conversation', generation: 1, createdAt: 1 });
  const discover = (runId: string) => rpc({ kind: 'context', stamp, nativeRunId: runId, owner: owner(runId) });
  const start = async (runId: string) => {
   await writeFile(join(dir, `${runId}.json`), JSON.stringify({ ...owner(runId), token: '1'.repeat(64) }));
   await prompt(undefined, { runId, agentId: 'agent', sessionKey: 'key', sessionId: 'session', workspaceDir: dir });
  };
  const end = (runId: string, { phase = 'end', writable = true, scoped = true } = {}) => {
   terminal({ runId, stream: 'lifecycle', data: { phase } }, scoped ? {
    setRunContext: (namespace, value) => {
     expect(namespace).toBe('aichat.gateway-context.v1');
     if (writable) records.set(runId, value);
    },
   } : undefined);
   closed.add(runId);
  };

  await start('old');
  expect(discover('old')).toMatchObject({ available: true });
  end('old');
  expect(discover('old')).toEqual({ available: false });
  end('old', { phase: 'error' });
  expect(discover('old')).toEqual({ available: false });
  end('old', { phase: 'aborted' });
  expect(rpc({ kind: 'observer' })).toMatchObject({ stamp, healthy: true });
  records.delete('old'); // Host cleanup cleared the old namespace.
  end('old', { scoped: false });
  expect(rpc({ kind: 'observer' })).toMatchObject({ stamp, healthy: true });
  end('old', { writable: false }); // After cleanup, an event-scoped write can now be a no-op.
  expect(discover('old')).toEqual({ available: false });
  expect(rpc({ kind: 'observer' })).toMatchObject({ stamp, healthy: true });
  await start('next');
  expect(discover('next')).toMatchObject({ available: true });

  end('next', { writable: false }); // An unacknowledged write may not leave a still-visible ready observation.
  expect(discover('next')).toEqual({ available: false });
  expect(rpc({ kind: 'observer' })).toMatchObject({ stamp, healthy: false });
 } finally {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
 }
});
