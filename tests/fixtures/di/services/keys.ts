import { ServiceProvider, Singleton } from "@zor/runtime";

export interface IClock {
  now(): number;
}

export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
}

export class KeyFactories {
  static port(): number {
    return 8080;
  }
  static clock(): SystemClock {
    return new SystemClock();
  }
}

export class Server {
  constructor(readonly port: string, readonly clock: IClock) {}
}

@ServiceProvider()
@Singleton("port", KeyFactories.port)
@Singleton("clock", KeyFactories.clock)
@Singleton(Server)
export class KeyServices {}
