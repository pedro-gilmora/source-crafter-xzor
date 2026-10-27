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

export interface IPosts {
  get(slug: string): Post | undefined;
  list(query: { tag?: string }): Post[];
  tags(): string[];
}
