import { Injectable, Logger } from '@nestjs/common';

/** Tells an edge cache that exported documents changed. */
export abstract class CdnPurger {
  abstract purge(version: number): Promise<void>;
}

/** Default: no CDN configured. ETag revalidation + s-maxage bound edge staleness. */
@Injectable()
export class NullCdnPurger extends CdnPurger {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}

export interface HttpCdnPurgerOptions {
  readonly purgeUrl: string;
  readonly token: string | undefined;
  readonly publicBaseUrl: string | undefined;
  readonly exportPath: string;
}

const PURGE_TIMEOUT_MS = 5_000;

/**
 * Generic HTTP purge hook (Cloudflare `purge_cache` / Fastly-style endpoint).
 * Purges the export prefix when a public base URL is configured, otherwise
 * everything in the zone.
 */
export class HttpCdnPurger extends CdnPurger {
  private readonly logger = new Logger(HttpCdnPurger.name);

  constructor(
    private readonly options: HttpCdnPurgerOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  async purge(version: number): Promise<void> {
    const { purgeUrl, token, publicBaseUrl, exportPath } = this.options;
    const body = publicBaseUrl
      ? { prefixes: [`${publicBaseUrl.replace(/\/$/, '')}${exportPath}`] }
      : { purge_everything: true };
    const response = await this.fetchImpl(purgeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`CDN purge failed with HTTP ${response.status}`);
    }
    this.logger.log({ version }, 'CDN purge requested');
  }
}
