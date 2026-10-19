import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  CatalogChangeFeed,
  CatalogChangeListener,
} from '../../catalog-events/catalog-change-notifier';
import type { AppConfig } from '../../config/app-config';
import { CdnPurgeSubscriber, ExportWarmer } from '../export-subscribers';
import type { ExportService } from '../export.service';
import { createCdnPurger } from '../export.module';
import { HttpCdnPurger, NullCdnPurger } from './cdn-purger';

const response = (ok: boolean, status: number): Response => ({ ok, status }) as Response;
const mockFetch = (result: Response) =>
  jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(result);
const sentBody = (fetchImpl: ReturnType<typeof mockFetch>): unknown =>
  JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);

describe('HttpCdnPurger', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('purges the export prefix with a bearer token when a public base URL is set', async () => {
    const fetchImpl = mockFetch(response(true, 200));
    const purger = new HttpCdnPurger(
      {
        purgeUrl: 'https://cdn.example/purge',
        token: 'secret',
        publicBaseUrl: 'https://cdn.example/',
        exportPath: '/api/v1/export/',
      },
      fetchImpl,
    );
    await purger.purge(5);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://cdn.example/purge');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer secret' });
    expect(sentBody(fetchImpl)).toEqual({ prefixes: ['https://cdn.example/api/v1/export/'] });
  });

  it('purges everything without a base URL or token', async () => {
    const fetchImpl = mockFetch(response(true, 200));
    await new HttpCdnPurger(
      { purgeUrl: 'https://p', token: undefined, publicBaseUrl: undefined, exportPath: '/x' },
      fetchImpl,
    ).purge(1);
    expect(sentBody(fetchImpl)).toEqual({ purge_everything: true });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
  });

  it('throws on a non-2xx purge response', async () => {
    const fetchImpl = mockFetch(response(false, 503));
    await expect(
      new HttpCdnPurger(
        { purgeUrl: 'https://p', token: undefined, publicBaseUrl: undefined, exportPath: '/x' },
        fetchImpl,
      ).purge(1),
    ).rejects.toThrow('HTTP 503');
  });
});

describe('createCdnPurger', () => {
  it('defaults to the null purger', async () => {
    const purger = createCdnPurger({
      purgeUrl: undefined,
      purgeToken: undefined,
      publicBaseUrl: undefined,
    });
    expect(purger).toBeInstanceOf(NullCdnPurger);
    await expect(purger.purge(1)).resolves.toBeUndefined();
  });

  it('uses the HTTP purger when a purge URL is configured', () => {
    expect(
      createCdnPurger({ purgeUrl: 'https://p', purgeToken: 't', publicBaseUrl: undefined }),
    ).toBeInstanceOf(HttpCdnPurger);
  });
});

describe('export subscribers', () => {
  function feed(): { feed: CatalogChangeFeed; listeners: CatalogChangeListener[] } {
    const listeners: CatalogChangeListener[] = [];
    return { feed: { subscribe: (l) => listeners.push(l) }, listeners };
  }
  const config = (warmOnChange: boolean) =>
    ({
      get: () => ({ warmOnChange, sideEffectDebounceMs: 5 }),
    }) as unknown as ConfigService<AppConfig, true>;

  it('purges the CDN once per burst of changes, for the latest version', async () => {
    const { feed: f, listeners } = feed();
    const purger = { purge: jest.fn().mockResolvedValue(undefined) };
    new CdnPurgeSubscriber(f, purger, config(false)).onModuleInit();
    const listener = listeners[0];
    await Promise.all([listener?.(7), listener?.(8), listener?.(9)]);
    expect(purger.purge).toHaveBeenCalledTimes(1);
    expect(purger.purge).toHaveBeenCalledWith(9);
  });

  it('warms exports only when enabled', async () => {
    const exports = { warm: jest.fn().mockResolvedValue(undefined) } as unknown as ExportService;
    const disabled = feed();
    new ExportWarmer(disabled.feed, exports, config(false)).onModuleInit();
    expect(disabled.listeners).toHaveLength(0);

    const enabled = feed();
    new ExportWarmer(enabled.feed, exports, config(true)).onModuleInit();
    await enabled.listeners[0]?.(1);
    expect(exports.warm).toHaveBeenCalledWith(['flat', 'nested']);
  });
});
