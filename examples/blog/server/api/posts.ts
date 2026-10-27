import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";
import type { IPosts, Post } from "../../contracts/posts";
import { PostStore } from "../posts-store";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  constructor(private store: PostStore) {}

  @Get(":slug")
  get(slug: string): Post | undefined { return this.store.find(slug); }

  @Get
  list(query: { tag?: string }): Post[] { return this.store.list(query); }

  @Get("tags")
  tags(): string[] { return this.store.tags(); }
}
