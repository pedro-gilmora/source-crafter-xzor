import type { Post } from "../contracts/posts";
import { posts } from "../client/posts";

export class PostStore {
  find(slug: string): Post | undefined {
    return posts.find((p) => p.slug === slug);
  }

  list(query: { tag?: string }): Post[] {
    return query.tag ? posts.filter((p) => p.tags.includes(query.tag!)) : posts;
  }
}
