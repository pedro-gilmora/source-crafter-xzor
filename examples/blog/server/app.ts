import { Run, Singleton } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
import Routes from "../client/Routes.xzor";
import { PostStore } from "./posts-store";

@Run(Routes)
@Singleton(PostStore)
export class App implements IServerApplication {}
