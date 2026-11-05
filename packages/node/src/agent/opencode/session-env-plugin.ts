import type { Plugin } from '@opencode-ai/plugin';
import { readRunBindFile, resolveRunBindDir } from './run-bind.js';
import { managedSession, NativeParents, readInput } from './input-bind.js';

/** Native adapter only: no HuLa/provider client or tools. See ADR-0004's bounded loopback lookup exception. */
export const SessionEnvPlugin: Plugin = async (native, options) => {
 const parents = new NativeParents();
 const budget = typeof options?.bindingTimeoutMs === 'number' && options.bindingTimeoutMs >= 0 && options.bindingTimeoutMs <= 35_000
  ? options.bindingTimeoutMs : 35_000;
 const loopback = native.serverUrl && ['http:', 'https:'].includes(native.serverUrl.protocol) &&
  ['127.0.0.1', '[::1]', 'localhost'].includes(native.serverUrl.hostname);
 return {
  // OpenCode does NOT await event promises. All ancestry mutations happen synchronously before returning.
  event: async ({ event }) => { parents.observe(event); },
  'chat.message': async (input, output) => {
   const dir = resolveRunBindDir();
   if (!await managedSession(dir, input.sessionID)) return;
   const binding = await readInput(dir, input.sessionID, input.messageID ?? output.message.id);
   if (!binding) throw new Error('native input persona binding missing');
   // This hook precedes its own message.updated: never wait for that event here.
   output.message.system = binding.systemPrompt;
  },
  'shell.env': async (input, output) => {
   Object.assign(output.env, {
    OPENCODE_SESSION_ID: input.sessionID ?? '', AICHAT_RUN_BIND: '',
    CODEX_THREAD_ID: '', OPENCLAW_BIND: '', AICHAT_BIND: '', AICHAT_CONTEXT_KEY: '',
   });
   if (!input.sessionID) return;
   const dir = resolveRunBindDir(), sessionID = input.sessionID;
   if (!await managedSession(dir, sessionID)) {
    // Compatibility for sessions predating native-input bindings; managed sessions NEVER take this branch.
    output.env.AICHAT_RUN_BIND = (await readRunBindFile(dir, sessionID))?.token ?? '';
    return;
   }
   if (!input.callID) throw new Error('native shell call binding missing');
   const deadline = Date.now() + budget;
   let lookedUp = false;
   do {
    let parent = parents.parent(sessionID, input.callID);
    if (!parent && !lookedUp && loopback && native.client) {
     lookedUp = true;
     const abort = new AbortController();
     let timer: ReturnType<typeof setTimeout> | undefined;
     try {
      const result = await Promise.race([
       native.client.session.messages({ path: { id: sessionID }, query: { directory: native.directory }, signal: abort.signal, redirect: 'error', throwOnError: true }),
       new Promise<undefined>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(undefined); }, Math.max(0, deadline - Date.now())); }),
      ]);
      for (const message of result?.data ?? []) {
       parents.observe({ type: 'message.updated', properties: { info: message.info } });
       for (const part of message.parts) parents.observe({ type: 'message.part.updated', properties: { part } });
      }
     } catch { /* A read failure is not permission to guess; keep the same bounded event window. */ }
     finally { if (timer) clearTimeout(timer); abort.abort(); }
     parent = parents.parent(sessionID, input.callID);
    }
    if (parent) {
     const binding = await readInput(dir, sessionID, parent.inputID);
     if (binding?.ready) { output.env.AICHAT_RUN_BIND = binding.ready.token; return; }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
   } while (Date.now() <= deadline);
   throw new Error('native shell binding timeout');
  },
 };
};
export default SessionEnvPlugin;
