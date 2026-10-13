import { type IApplication, Import, Mount, Singleton, Transient } from "@zor/runtime";
import App from "./App.tszor";
import { AuthService, Clock } from "./services/auth";
import { DataServices } from "./services/data";
import { type Settings } from "./services/settings";

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
@Transient(Clock)
@Singleton("requestId", Factories.newRequestId)
@Singleton("settings", Factories.loadSettings)
export class Application implements IApplication {}

