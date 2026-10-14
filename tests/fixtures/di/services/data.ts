import { Scoped, ServiceProvider, Singleton } from "@xzor/runtime";

export interface ILogger {
  log(message: string): void;
}

export class ConsoleLogger implements ILogger {
  log(message: string): void {
    console.log(message);
  }
}

export interface IDatabase {
  readonly name: string;
}

export class Database implements IDatabase {
  readonly name = "db";
  constructor(readonly log: ILogger) {}
  dispose(): void {}
}

export class UnitOfWork {
  constructor(readonly db: IDatabase) {}
}

@ServiceProvider()
@Singleton<ILogger>(ConsoleLogger)
@Singleton<IDatabase>(Database)
@Scoped(UnitOfWork)
export class DataServices {}
