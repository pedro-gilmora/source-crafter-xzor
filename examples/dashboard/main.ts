import "@source-crafter/xzor-ui";
import "./app.css";
import { type IApplication, Run } from "@source-crafter/xzor-runtime";
import Routes from "./Routes.xzor";

@Run(Routes, "app")
export class Application implements IApplication {}
