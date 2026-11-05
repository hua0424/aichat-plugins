/** Wire values are normalized only for fingerprinting; skill arguments preserve their exact content. */
export function capabilityParameters(operation: string, capabilityId: string | undefined, raw: unknown): Record<string, string | number> {
 if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('invalid_parameters');
 const p = (raw ?? {}) as Record<string, unknown>;
 const keys = Object.keys(p);
 const only = (...allowed: string[]) => { if (keys.some((k) => !allowed.includes(k))) throw new Error('invalid_parameters'); };
 const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
 if (operation === 'discover' && capabilityId === 'model.set') {
  only('query', 'offset');
  const query = p.query ?? '', offset = p.offset ?? 0;
  if (typeof query !== 'string' || query.length > 256 || !Number.isSafeInteger(offset) || (offset as number) < 0 || p.query === null || p.offset === null) throw new Error('invalid_parameters');
  return { query, offset: offset as number };
 }
 if (operation === 'invoke' && capabilityId === 'model.set') {
  only('providerId', 'modelId');
  if (!identifier(p.providerId) || !identifier(p.modelId)) throw new Error('invalid_parameters');
  return { providerId: p.providerId, modelId: p.modelId };
 }
 if (operation === 'invoke' && capabilityId?.startsWith('skill:')) {
  only('arguments');
  if (!identifier(capabilityId.slice(6)) || (p.arguments !== undefined && (typeof p.arguments !== 'string' || p.arguments.length > 4096))) throw new Error('invalid_parameters');
  return { arguments: (p.arguments as string | undefined) ?? '' };
 }
 only();
 return {};
}
export const isMutation = (operation: string, capabilityId?: string): boolean => operation === 'invoke' &&
 (['model.set', 'session.reset', 'session.compact'].includes(capabilityId ?? '') || capabilityId?.startsWith('skill:') === true);
