import { Mount, Singleton } from "@zor/runtime";
import App from "./App.tszor";
import { Database } from "./services";

@Mount(App, "app")
@Singleton(Database)
export class Application {}
