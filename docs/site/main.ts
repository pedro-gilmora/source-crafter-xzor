import "@source-crafter/xzor-ui";
import "./site.css";
import { type IApplication, Run, viewTransitions } from "@source-crafter/xzor-runtime";
import Routes from "./Routes.xzor";

viewTransitions(true);

@Run(Routes, "app")
export class Application implements IApplication {}
