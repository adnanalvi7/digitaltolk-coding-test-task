import { Inject } from '@nestjs/common';

export const KYSELY = Symbol('KYSELY');

/** Parameter decorator for injecting the shared Kysely instance. */
export const InjectDb = (): ParameterDecorator => Inject(KYSELY);
