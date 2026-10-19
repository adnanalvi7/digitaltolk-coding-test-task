import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PROBLEM_CONTENT_TYPE, toProblemDetails } from '../errors/problem-details';

/**
 * The single place where any thrown value becomes an HTTP response.
 * Every error body is RFC 7807 problem+json and carries the request id.
 */
@Catch()
export class ProblemDetailsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const { problem, headers, isServerError } = toProblemDetails(exception, {
      instance: request.url.split('?', 1)[0] ?? request.url,
      requestId: request.id,
    });

    if (isServerError) {
      this.logger.error(
        { err: exception, requestId: request.id, method: request.method, url: request.url },
        'Unhandled error while processing request',
      );
    }
    if (reply.sent) return;

    void reply
      .status(problem.status)
      .headers(headers)
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .send(JSON.stringify(problem));
  }
}
