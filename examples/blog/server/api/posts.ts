import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";
import type { IPosts, PostPage, PostSummary } from "../../contracts/posts";
import { PostStore } from "../posts-store";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  constructor(private store: PostStore) {}

  @Get(":slug")
  get(slug: string): PostPage | undefined { return this.store.find(slug); }

  @Get
  list(query: { tag?: string }): PostSummary[] { return this.store.list(query); }
}
