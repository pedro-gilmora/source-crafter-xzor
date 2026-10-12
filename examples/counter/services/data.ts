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
  constructor(readonly db: IDatabase) {}
}

@ServiceProvider()
@Singleton<ILogger>(ConsoleLogger)
@Singleton<IDatabase>(Database)
@Scoped(UnitOfWork)
export class DataServices {}
