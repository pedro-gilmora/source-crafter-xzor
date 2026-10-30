import { type IApplication, Run } from "@source-crafter/xzor-runtime";
import Tasks from "./Tasks.xzor";

@Run(Tasks, "app")
export class Application implements IApplication {}
