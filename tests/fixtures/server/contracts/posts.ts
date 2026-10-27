export interface Post {
  slug: string;
  title: string;
  tag?: string;
}

export interface NewPost {
  title: string;
  tag?: string;
}

export interface IPosts {
  get(slug: string): Post | undefined;
  list(query: { tag?: string; page?: number }): Post[];
  create(body: NewPost): Promise<Post>;
}
