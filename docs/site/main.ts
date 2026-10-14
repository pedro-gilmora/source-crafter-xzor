import { type IApplication, Mount } from "@source-crafter/xzor-runtime";
import Routes from "./Routes.xzor";

@Mount(Routes, "app")
export class Application implements IApplication {}
