import "@source-crafter/xzor-ui";
import "./app.css";
import { type IApplication, Mount, Singleton } from "@source-crafter/xzor-runtime";
import Routes from "./Routes.xzor";
import { Cart } from "./store";

@Mount(Routes, "app")
@Singleton(Cart)
export class Application implements IApplication {}
