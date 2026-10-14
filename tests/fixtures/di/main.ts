import { Import, Mount, Singleton as Single, Transient } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";
import { DataServices, type IDatabase as Db } from "./services/data";

export class Cache {}

export class AuthService {
  constructor(readonly db: Db) {}
}

export class Report {
  constructor(readonly cache: Promise<Cache>, readonly requestId?: string) {}
}

// A class cannot reference itself in its own decorators (TS2449, and a TDZ error at runtime).
export class Factories {
  static _newRequestId(): string {
    return crypto.randomUUID();
  }
  static async _loadCache(): Promise<Cache> {
    return new Cache();
  }
}

@Mount(App, "app")
@Import(DataServices)
@Single(AuthService)
@Transient(Report)
@Single("requestId", Factories._newRequestId)
@Single("cache", Factories._loadCache)
export class Application {}
