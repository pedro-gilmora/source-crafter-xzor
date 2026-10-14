import { Mount, Singleton } from "@xzor/runtime";
import App from "./App.xzor";
import { Database } from "./services";

@Mount(App, "app")
@Singleton(Database)
export class Application {}
