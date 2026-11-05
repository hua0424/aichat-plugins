export interface CompactObservation { before: ReadonlySet<string>; after: ReadonlySet<string>; reliable: boolean }
/** Only edges present in every request-saturating matching prove ownership. */
export function attributeCompactions(rows: readonly CompactObservation[]): (string | undefined)[] {
 const unknown = rows.map(() => undefined);
 if (rows.some((row) => !row.reliable)) return unknown;
 const edges = rows.map((row) => [...row.after].filter((id) => !row.before.has(id)));
 // ponytail: repeated augmenting-path matching suits small overlap groups; optimize only with measured contention.
 const match = (forbiddenRow = -1, forbiddenId = '') => {
  const owner = new Map<string, number>();
  const augment = (row: number, seen: Set<string>): boolean => {
   for (const id of edges[row]) {
    if ((row === forbiddenRow && id === forbiddenId) || seen.has(id)) continue;
    seen.add(id);
    const previous = owner.get(id);
    if (previous === undefined || augment(previous, seen)) { owner.set(id, row); return true; }
   }
   return false;
  };
  for (let row = 0; row < rows.length; row++) if (!augment(row, new Set())) return undefined;
  const assigned: (string | undefined)[] = rows.map(() => undefined);
  for (const [id, row] of owner) assigned[row] = id;
  return assigned;
 };
 const baseline = match();
 return baseline ? baseline.map((id, row) => match(row, id) ? undefined : id) : unknown;
}
interface Member { done: boolean; observation?: CompactObservation; resolve(id?: string): void }
/** Groups observation windows, never native submission: callers execute immediately. */
export class CompactionAttribution {
 private readonly groups = new Map<string, Member[]>();
 begin(key: string): (observation?: CompactObservation) => Promise<string | undefined> {
  let group = this.groups.get(key);
  if (!group) { group = []; this.groups.set(key, group); }
  let resolve!: (id?: string) => void;
  const result = new Promise<string | undefined>((r) => { resolve = r; });
  const member: Member = { done: false, resolve }; group.push(member);
  return (observation) => {
   if (member.done) return result;
   member.done = true; member.observation = observation;
   if (group.every((m) => m.done)) {
    this.groups.delete(key);
    const submitted = group.filter((m) => m.observation);
    const assigned = attributeCompactions(submitted.map((m) => m.observation!));
    for (const m of group) m.resolve(m.observation ? assigned[submitted.indexOf(m)] : undefined);
   }
   return result;
  };
 }
}
