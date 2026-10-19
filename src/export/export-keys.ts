import { shortDigest as digest } from '../common/crypto/hash';
import type { TagFilter } from '../translations/translation.model';
import type { ExportFormat } from './formatters/export-formatter';

/**
 * `export:{locale}:{format}:{tags}:v{version}`. Tags are sorted so `a,b` and
 * `b,a` share an entry. The version suffix retires every entry on each write.
 */
export function exportCacheKey(
  localeCode: string,
  format: ExportFormat,
  tags: TagFilter | undefined,
  version: number,
): string {
  const tagPart =
    tags === undefined || tags.names.length === 0
      ? 'all'
      : `${tags.mode}-${digest([...new Set(tags.names)].sort().join(','))}`;
  return `export:${localeCode}:${format}:${tagPart}:v${version}`;
}

/** Weak validator: the document is semantically identical whatever the transfer encoding. */
export function weakEtag(cacheKey: string): string {
  return `W/"${digest(cacheKey)}"`;
}

/** RFC 9110 weak comparison against an If-None-Match header (list or `*`). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const opaque = etag.replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate.replace(/^W\//, '') === opaque);
}

/** True if the client accepts gzip (any q > 0, or `*` with q > 0). */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) return false;
  return acceptEncoding.split(',').some((part) => {
    const [coding = '', ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}
