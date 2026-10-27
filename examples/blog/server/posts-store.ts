import type { Post } from "../contracts/posts";
import { posts } from "./posts-data";

export class PostStore {
  find(slug: string): Post | undefined {
    return posts.find((p) => p.slug === slug);
  }

  list(query: { tag?: string }): Post[] {
    return query.tag ? posts.filter((p) => p.tags.includes(query.tag!)) : posts;
  }

  tags(): string[] {
    return [...new Set(posts.flatMap((p) => p.tags))].sort();
  }
}
