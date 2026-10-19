import { Injectable } from '@nestjs/common';

/** Time source abstraction so expiry logic is deterministic under test. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
