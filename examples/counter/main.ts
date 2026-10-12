import { type IApplication, Import, Mount, Singleton } from "@zor/runtime";
import App from "./App.tszor";
import { DataServices, type IDatabase } from "./services/data";
import { type Settings } from "./services/settings";

export class AuthService {
  constructor(readonly db: IDatabase) {}
}

// A class cannot reference itself in its own decorators, so the factories live elsewhere.
export class Factories {
  static newRequestId(): string {
    return crypto.randomUUID();
  }
  static loadSettings(): Promise<Settings> {
    return new Promise((resolve) => setTimeout(() => resolve({ greeting: "Hello from async settings" }), 0));
  }
}

@Mount(App, "app")
@Import(DataServices)
@Singleton(AuthService)
@Singleton("requestId", Factories.newRequestId)
@Singleton("settings", Factories.loadSettings)
export class Application implements IApplication {}

