import { containsPattern, escapeLikeTerm, prefixPattern } from './like-pattern';

describe('LIKE escaping', () => {
  it('escapes %, _ and backslash so they match literally', () => {
    expect(escapeLikeTerm('100%_off\\now')).toBe('100\\%\\_off\\\\now');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeLikeTerm('checkout.button')).toBe('checkout.button');
  });

  it('builds an index-friendly prefix pattern (no leading wildcard)', () => {
    expect(prefixPattern('item_1')).toBe('item\\_1%');
    expect(prefixPattern('a')).not.toMatch(/^%/);
  });

  it('builds a contains pattern for trigram search', () => {
    expect(containsPattern('50%')).toBe('%50\\%%');
  });
});
