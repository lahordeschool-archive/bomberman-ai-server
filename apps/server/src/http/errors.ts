import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { RunnerUnavailableError } from '../runner/executor.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'That page') =>
  new HttpError(404, 'not_found', `${what} does not exist.`);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Please sign in to continue.');
export const forbidden = (message = 'You are not allowed to do that.') =>
  new HttpError(403, 'forbidden', message);

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ZodError) {
    void reply.status(400).send({
      error: 'validation',
      message: error.issues[0]?.message ?? 'Some fields are invalid.',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return;
  }
  if (error instanceof HttpError) {
    void reply.status(error.status).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof RunnerUnavailableError) {
    void reply.status(503).send({ error: 'runner_unavailable', message: error.message });
    return;
  }
  const status = (error as FastifyError).statusCode ?? 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed');
    void reply
      .status(500)
      .send({ error: 'internal', message: 'Something went wrong on our side. Please try again.' });
    return;
  }
  const code = status === 429 ? 'rate_limited' : ((error as FastifyError).code ?? 'bad_request');
  void reply.status(status).send({ error: code, message: error.message });
}
