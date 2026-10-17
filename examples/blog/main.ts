import "@source-crafter/xzor-ui";
import "./app.css";
import { type IApplication, Mount, viewTransitions } from "@source-crafter/xzor-runtime";
import Routes from "./Routes.xzor";

viewTransitions(true);

@Mount(Routes, "app")
export class Application implements IApplication {}
