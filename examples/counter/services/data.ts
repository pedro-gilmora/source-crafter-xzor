import { Scoped, ServiceProvider, Singleton } from "@zor/runtime";

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
  readonly name = "in-memory db";
  constructor(readonly logger: ILogger) {
    logger.log("database opened");
  }
  dispose(): void {
    this.logger.log("database closed");
  }
}

export class UnitOfWork {
  changes = 0;
  constructor(readonly db: IDatabase) {}
  track(): void {
    this.changes++;
  }
  dispose(): void {
    console.log(`unit of work closed after ${this.changes} changes`);
  }
}

@ServiceProvider()
@Singleton<ILogger>(ConsoleLogger)
@Singleton<IDatabase>(Database)
@Scoped(UnitOfWork)
export class DataServices {}
