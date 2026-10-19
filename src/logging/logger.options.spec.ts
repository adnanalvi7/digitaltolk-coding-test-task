import type { IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { buildLoggerOptions } from './logger.options';

const appConfig = (env: 'development' | 'production') => ({
  env,
  host: '0.0.0.0',
  port: 3000,
  logLevel: 'info',
  trustProxy: false,
  corsOrigins: [],
  bodyLimitBytes: 1,
  swaggerEnabled: true,
  workers: 1,
});

interface PinoHttpOptions {
  redact: { paths: string[]; censor: string };
  genReqId: (req: IncomingMessage) => string;
  autoLogging: { ignore: (req: IncomingMessage) => boolean };
  transport?: unknown;
}

describe('buildLoggerOptions', () => {
  const options = buildLoggerOptions(appConfig('production')).pinoHttp as PinoHttpOptions;

  it('redacts credentials anywhere they appear', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino({ redact: options.redact }, sink);
    logger.info({
      req: {
        headers: { authorization: 'Bearer tms_secret', cookie: 'sid=1' },
        body: { password: 'hunter2' },
      },
      login: { password: 'hunter2', token: 'tms_secret' },
    });
    const output = lines.join('');
    expect(output).not.toMatch(/tms_secret|hunter2|sid=1/);
    expect(output).toContain('[REDACTED]');
  });

  it('uses the shared request-id resolver and skips health-check access logs', () => {
    const req = {
      headers: { 'x-request-id': '0f8fad5b-d9cb-469f-a165-70867728950e' },
      url: '/api/v1/health/live',
    };
    expect(options.genReqId(req as unknown as IncomingMessage)).toBe(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
    expect(options.autoLogging.ignore(req as unknown as IncomingMessage)).toBe(true);
    expect(options.autoLogging.ignore({ url: '/api/v1/locales' } as IncomingMessage)).toBe(false);
    expect(options.autoLogging.ignore({} as IncomingMessage)).toBe(false);
  });

  it('pretty-prints only in development', () => {
    expect(options.transport).toBeUndefined();
    expect(
      (buildLoggerOptions(appConfig('development')).pinoHttp as PinoHttpOptions).transport,
    ).toBeDefined();
  });
});
