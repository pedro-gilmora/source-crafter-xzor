import { Run, Singleton } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";
import { Database } from "./services";

@Run(App, "app")
@Singleton(Database)
export class Application {}
