import { type IApplication, Import, Mount, Singleton, Transient } from "@xzor/runtime";
import App from "./App.xzor";
import { AuthService, Clock } from "./services/auth";
import { DataServices } from "./services/data";
import { type Settings } from "./services/settings";

// A class cannot reference itself in its own decorators, so the factories live elsewhere.
export class Factories {
  static loadSettings(): Promise<Settings> {
    return new Promise((resolve) => setTimeout(() => resolve({ greeting: "Hello from async injected settings" }), 0));
  }
}
export function newRequestId(): string {
  return crypto.randomUUID();
}
@Mount(App, "app")
@Import(DataServices)
@Singleton(AuthService)
@Transient(Clock)
@Singleton("requestId", newRequestId)
@Singleton("settings", Factories.loadSettings)
export class Application implements IApplication {}

