import type { Post, PostPage, PostSummary } from "../contracts/posts";
import { posts } from "./posts-data";

const summary = ({ body: _, ...rest }: Post): PostSummary => rest;

export class PostStore {
  find(slug: string): PostPage | undefined {
    const i = posts.findIndex((p) => p.slug === slug);
    return i < 0 ? undefined : { post: posts[i]!, next: summary(posts[(i + 1) % posts.length]!) };
  }

  list(query: { tag?: string }): PostSummary[] {
    return (query.tag ? posts.filter((p) => p.tags.includes(query.tag!)) : posts).map(summary);
  }

  tags(): string[] {
    return [...new Set(posts.flatMap((p) => p.tags))].sort();
  }
}
