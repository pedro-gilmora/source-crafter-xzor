import { Model } from "@source-crafter/xzor-runtime/model";

export interface Product {
  id: string;
  name: string;
  unit: string;
  price: number;
  category: string;
  /** Hue of its tile. */
  hue: number;
}

export interface Line {
  product: Product;
  qty: number;
}

export interface Placed {
  id: string;
  customer: string;
  lines: Line[];
  total: number;
  at: Date;
}

export const categories = ["All", "Fruit", "Bakery", "Dairy", "Pantry"];

export const products: Product[] = [
  { id: "p1", name: "Blood oranges", unit: "1 kg", price: 4.2, category: "Fruit", hue: 40 },
  { id: "p2", name: "Pink Lady apples", unit: "6 pcs", price: 3.6, category: "Fruit", hue: 15 },
  { id: "p3", name: "Figs", unit: "250 g", price: 5.9, category: "Fruit", hue: 330 },
  { id: "p4", name: "Sourdough loaf", unit: "800 g", price: 6.5, category: "Bakery", hue: 70 },
  { id: "p5", name: "Croissants", unit: "4 pcs", price: 5.2, category: "Bakery", hue: 85 },
  { id: "p6", name: "Rye crackers", unit: "200 g", price: 3.1, category: "Bakery", hue: 55 },
  { id: "p7", name: "Greek yogurt", unit: "500 g", price: 3.4, category: "Dairy", hue: 230 },
  { id: "p8", name: "Aged manchego", unit: "250 g", price: 8.9, category: "Dairy", hue: 95 },
  { id: "p9", name: "Oat milk", unit: "1 l", price: 2.7, category: "Dairy", hue: 200 },
  { id: "p10", name: "Olive oil", unit: "500 ml", price: 11.5, category: "Pantry", hue: 120 },
  { id: "p11", name: "Arborio rice", unit: "1 kg", price: 4.8, category: "Pantry", hue: 260 },
  { id: "p12", name: "Smoked paprika", unit: "75 g", price: 3.9, category: "Pantry", hue: 25 },
];

export const price = (n: number): string => n.toLocaleString("en-US", { style: "currency", currency: "EUR" });

/** The basket and the orders placed from it; a singleton every screen reads. */
export class Cart extends Model {
  lines: Line[] = [];
  orders: Placed[] = [];

  // No parameters: the injector builds it (Model's own takes optional data).
  constructor() {
    super();
    this.assign();
  }

  get count(): number {
    return this.lines.reduce((n, l) => n + l.qty, 0);
  }

  get total(): number {
    return this.lines.reduce((sum, l) => sum + l.qty * l.product.price, 0);
  }

  qty(product: Product): number {
    return this.lines.find((l) => l.product === product)?.qty ?? 0;
  }

  change(product: Product, by: number): void {
    const known = this.lines.some((l) => l.product === product);
    const lines = known ? this.lines.map((l) => (l.product === product ? { product, qty: l.qty + by } : l)) : [...this.lines, { product, qty: by }];
    this.lines = lines.filter((l) => l.qty > 0);
  }

  place(customer: string): Placed {
    const order = { id: `B-${1042 + this.orders.length}`, customer, lines: this.lines, total: this.total, at: new Date() };
    this.orders = [order, ...this.orders];
    this.lines = [];
    return order;
  }
}
