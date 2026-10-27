import type { NewPost, Post } from "../contracts/posts";

export class PostStore {
  #posts: Post[] = [];

  find(slug: string): Post | undefined {
    return this.#posts.find((p) => p.slug === slug);
  }

  list(query: { tag?: string; page?: number }): Post[] {
    return this.#posts.filter((p) => !query.tag || p.tag === query.tag);
  }

  async add(body: NewPost): Promise<Post> {
    const post = { ...body, slug: body.title.toLowerCase().replaceAll(" ", "-") };
    this.#posts.push(post);
    return post;
  }
}
