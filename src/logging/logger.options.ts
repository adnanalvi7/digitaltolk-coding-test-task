import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config/app-config';
import { resolveRequestId } from '../common/http/request-id';

/** Secrets that must never reach a log line, wherever they appear. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.token',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.authorization',
];

export function buildLoggerOptions(app: AppConfig['app']): Params {
  return {
    pinoHttp: {
      level: app.logLevel,
      genReqId: (req: IncomingMessage) => resolveRequestId(req),
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url?.startsWith('/api/v1/health') ?? false,
      },
      ...(app.env === 'development'
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
    },
  };
}
