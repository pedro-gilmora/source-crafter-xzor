import { Run, Singleton } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
import Shell from "../client/Shell.xzor";
import { PostStore } from "./store";

@Run(Shell)
@Singleton(PostStore)
export class App implements IServerApplication {
  port = 3000;
}
