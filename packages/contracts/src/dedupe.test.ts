import { dedupeHash } from './dedupe';
describe('dedupeHash', () => {
  it('is stable for the same inputs', () => {
    const a = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    const b = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    expect(a).toBe(b);
  });
  it('differs when amount differs', () => {
    const a = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    const b = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -13.0, merchantRaw: 'TESCO' });
    expect(a).not.toBe(b);
  });
  it('is scoped per user', () => {
    const a = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    const b = dedupeHash({ userId: 'u2', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    expect(a).not.toBe(b);
  });
});
