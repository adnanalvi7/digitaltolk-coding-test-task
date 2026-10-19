import { type ArgumentsHost, Logger } from '@nestjs/common';
import { TranslationKeyNotFoundError } from '../errors/errors';
import { ProblemDetailsExceptionFilter } from './problem-details.filter';

function host(sent = false) {
  const reply = {
    sent,
    status: jest.fn().mockReturnThis(),
    headers: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    send: jest.fn<unknown, [string]>().mockReturnThis(),
  };
  const request = { id: 'req-9', url: '/api/v1/translations/5?x=1', method: 'GET' };
  const argumentsHost = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  return { reply, argumentsHost };
}

describe('ProblemDetailsExceptionFilter', () => {
  const filter = new ProblemDetailsExceptionFilter();
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes problem+json without the query string and does not log client errors', () => {
    const { reply, argumentsHost } = host();
    filter.catch(new TranslationKeyNotFoundError('5'), argumentsHost);
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.header).toHaveBeenCalledWith(
      'content-type',
      'application/problem+json; charset=utf-8',
    );
    const body = JSON.parse(reply.send.mock.calls[0]?.[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ instance: '/api/v1/translations/5', requestId: 'req-9' });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('logs server errors with the request id', () => {
    const { argumentsHost } = host();
    filter.catch(new Error('db exploded'), argumentsHost);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-9' }),
      'Unhandled error while processing request',
    );
  });

  it('does not write twice if a response was already sent', () => {
    const { reply, argumentsHost } = host(true);
    filter.catch(new Error('late'), argumentsHost);
    expect(reply.send).not.toHaveBeenCalled();
  });
});
