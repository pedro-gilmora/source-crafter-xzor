export type Block = { h: string } | { p: string } | { code: string } | { quote: string };

export interface Post {
  slug: string;
  title: string;
  summary: string;
  date: string;
  minutes: number;
  tags: string[];
  body: Block[];
}

/** What a list shows: a post without its body. */
export type PostSummary = Omit<Post, "body">;

/** A post and the one to read after it. */
export interface PostPage {
  post: Post;
  next: PostSummary;
}

export interface IPosts {
  get(slug: string): PostPage | undefined;
  list(query: { tag?: string }): PostSummary[];
}

export interface ITags {
  all(): string[];
}
