import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";
import type { ITags } from "../../contracts/posts";
import { PostStore } from "../posts-store";

@Endpoints("/api/tags")
export class Tags implements ITags {
  constructor(private store: PostStore) {}

  @Get
  all(): string[] { return this.store.tags(); }
}
