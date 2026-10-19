import { TagMatchMode } from '../translations/translation.model';
import { acceptsGzip, etagMatches, exportCacheKey, weakEtag } from './export-keys';
import { ExportFormat } from './formatters/export-formatter';

describe('exportCacheKey', () => {
  it('embeds locale, format, tag filter and catalog version', () => {
    expect(exportCacheKey('en', ExportFormat.Flat, undefined, 7)).toBe('export:en:flat:all:v7');
  });

  it('is independent of tag order and duplicates', () => {
    const a = exportCacheKey(
      'en',
      ExportFormat.Nested,
      { names: ['web', 'mobile'], mode: TagMatchMode.Any },
      1,
    );
    const b = exportCacheKey(
      'en',
      ExportFormat.Nested,
      { names: ['mobile', 'web', 'web'], mode: TagMatchMode.Any },
      1,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^export:en:nested:any-[\w-]{16}:v1$/);
  });

  it('distinguishes tag modes, versions and an empty tag list', () => {
    const tags = ['web'];
    const any = exportCacheKey('en', ExportFormat.Flat, { names: tags, mode: TagMatchMode.Any }, 1);
    const all = exportCacheKey('en', ExportFormat.Flat, { names: tags, mode: TagMatchMode.All }, 1);
    expect(any).not.toBe(all);
    expect(exportCacheKey('en', ExportFormat.Flat, undefined, 2)).not.toBe(
      exportCacheKey('en', ExportFormat.Flat, undefined, 1),
    );
    expect(exportCacheKey('en', ExportFormat.Flat, { names: [], mode: TagMatchMode.Any }, 1)).toBe(
      'export:en:flat:all:v1',
    );
  });
});

describe('ETags', () => {
  const etag = weakEtag('export:en:flat:all:v1');

  it('produces a weak validator', () => {
    expect(etag).toMatch(/^W\/"[\w-]{16}"$/);
  });

  it.each([
    [etag, true],
    [etag.replace('W/', ''), true],
    [`W/"other", ${etag}`, true],
    ['*', true],
    ['W/"other"', false],
    [undefined, false],
  ])('If-None-Match %p matches: %p', (header, expected) => {
    expect(etagMatches(header, etag)).toBe(expected);
  });
});

describe('acceptsGzip', () => {
  it.each([
    ['gzip, deflate, br', true],
    ['br;q=1.0, gzip;q=0.8', true],
    ['*', true],
    ['gzip;q=0', false],
    ['identity', false],
    ['br', false],
    [undefined, false],
    ['', false],
  ])('%p → %p', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });
});
