import { Endpoints, Get, Post as PostMethod } from "@source-crafter/xzor-runtime/server";
import type { IPosts, NewPost, Post } from "../../contracts/posts";
import { PostStore } from "../store";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  constructor(private store: PostStore) {}

  @Get(":slug")
  get(slug: string): Post | undefined { return this.store.find(slug); }

  @Get
  list(query: { tag?: string; page?: number }): Post[] { return this.store.list(query); }

  @PostMethod
  async create(body: NewPost): Promise<Post> { return this.store.add(body); }
}
