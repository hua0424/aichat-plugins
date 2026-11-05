import { expect, it } from 'vitest';
import { attributeCompactions, CompactionAttribution } from './compaction-attribution.js';
const o = (before: string[], after: string[], reliable = true) => ({ before: new Set(before), after: new Set(after), reliable });
it('proves only unique one-to-one edges, including forced edges among ambiguous peers', () => {
 expect(attributeCompactions([o([], ['a']), o(['a'], ['a', 'b'])])).toEqual(['a', 'b']);
 expect(attributeCompactions([o([], ['a']), o([], ['a'])])).toEqual([undefined, undefined]);
 expect(attributeCompactions([o([], ['a', 'b']), o([], ['a', 'b'])])).toEqual([undefined, undefined]);
 expect(attributeCompactions([o([], ['a', 'b']), o([], ['b'])])).toEqual(['a', 'b']);
 expect(attributeCompactions([o([], ['a']), o([], ['b', 'c']), o([], ['b', 'c'])])).toEqual(['a', undefined, undefined]);
 expect(attributeCompactions([o([], ['a', 'b'])])).toEqual([undefined]);
 expect(attributeCompactions([o([], []), o([], ['b'])])).toEqual([undefined, undefined]);
 expect(attributeCompactions([o([], ['a'], false), o([], ['b'])])).toEqual([undefined, undefined]);
});
it('retains settled members until transitive observation closure, without coupling other sessions', async () => {
 const groups = new CompactionAttribution(), a = groups.begin('s'), b = groups.begin('s');
 let done = false;
 const first = a(o([], ['a'])).then((id) => { done = true; return id; });
 await Promise.resolve(); expect(done).toBe(false);
 const c = groups.begin('s'), last = c(o(['a', 'b'], ['a', 'b', 'c']));
 expect(await groups.begin('other')(o([], ['independent']))).toBe('independent');
 expect(done).toBe(false);
 const second = b(o(['a'], ['a', 'b']));
 expect(await Promise.all([first, second, last])).toEqual(['a', 'b', 'c']);
});
