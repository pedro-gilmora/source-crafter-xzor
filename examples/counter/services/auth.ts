import type { IDatabase } from "./data";

export class Clock {
  now(): Date {
    return new Date();
  }
}

export class AuthService {
  readonly signedInAt: Date;
  // `requestId` resolves by key before type: it is the keyed `string` singleton, not a type lookup.
  constructor(
    readonly db: IDatabase,
    readonly requestId: string,
    clock: Clock,
  ) {
    this.signedInAt = clock.now();
  }
}
