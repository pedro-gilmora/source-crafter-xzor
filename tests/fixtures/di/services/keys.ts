import { ServiceProvider, Singleton } from "@xzor/runtime";

export interface IClock {
  now(): number;
}

export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
  monotonic(): boolean {
    return true;
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

export class LabelFactories {
  static label(port: number): string {
    return `port-${port}`;
  }
}

export class Server {
  constructor(readonly port: string, readonly clock: IClock) {}
}

@ServiceProvider()
@Singleton("port", KeyFactories.port)
@Singleton("clock", KeyFactories.clock)
@Singleton("label", LabelFactories.label)
@Singleton(Server)
export class KeyServices {}
