// Made-up but steady data: a seeded generator gives the same orders on every load.
import type { Column } from "@source-crafter/xzor-ui";

export type Status = "Paid" | "Pending" | "Refunded";

export interface Order {
  id: string;
  customer: string;
  city: string;
  items: number;
  total: number;
  status: Status;
  date: Date;
}

const customers = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Linus Torvalds", "Margaret Hamilton", "Dennis Ritchie", "Radia Perlman", "Ken Thompson", "Barbara Liskov", "Tim Berners-Lee", "Frances Allen"];
const cities = ["Lisbon", "Madrid", "Berlin", "Austin", "Toronto", "Osaka", "Bogotá", "Lyon"];

function random(seed: number): () => number {
  return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

const next = random(7);
const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
const today = new Date(2026, 9, 17);

export const orders: Order[] = Array.from({ length: 48 }, (_, i) => {
  const roll = next();
  return {
    id: `#${4120 - i}`,
    customer: pick(customers),
    city: pick(cities),
    items: 1 + Math.floor(next() * 6),
    total: Math.round(18 + next() * 420),
    status: roll < 0.7 ? "Paid" : roll < 0.92 ? "Pending" : "Refunded",
    date: new Date(today.getTime() - i * 5.5 * 3600_000),
  };
});

export const periods = ["Day", "Week", "Month"];

const scale: Record<string, number> = { Day: 1, Week: 7, Month: 30 };

export interface Kpi {
  label: string;
  value: string;
  unit: string;
  delta: number;
}

export function kpis(period: string): Kpi[] {
  const f = scale[period] ?? 1;
  return [
    { label: "Revenue", value: money(6890 * f), unit: "", delta: period === "Month" ? 12.4 : period === "Week" ? 4.1 : -2.3 },
    { label: "Orders", value: String(31 * f), unit: "", delta: period === "Day" ? 3.2 : 6.8 },
    { label: "Average order", value: money(222 - f * 0.4), unit: "", delta: -0.9 },
    { label: "Conversion", value: (3.1 + f / 100).toFixed(1), unit: "%", delta: 0.6 },
  ];
}

export interface Bar {
  label: string;
  /** 0 to 1 of the tallest bar. */
  share: number;
  value: string;
}

export function series(period: string): Bar[] {
  const labels =
    period === "Day" ? ["9h", "11h", "13h", "15h", "17h", "19h", "21h"] : period === "Week" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["W1", "W2", "W3", "W4"];
  const gen = random(labels.length * 31);
  const values = labels.map(() => 30 + gen() * 70);
  const top = Math.max(...values);
  return labels.map((label, i) => ({ label, share: values[i]! / top, value: money(values[i]! * (scale[period] ?? 1) * 12) }));
}

export const money = (n: number): string => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const when = (d: Date): string => d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const orderColumns: Column<Order>[] = [
  { label: "Order", value: (o) => o.id, sort: false },
  { label: "Customer", value: (o) => o.customer },
  { label: "City", value: (o) => o.city },
  { label: "Status", value: (o) => o.status },
  { label: "Date", value: (o) => o.date.getTime(), text: (o) => when(o.date) },
  { label: "Total", value: (o) => o.total, text: (o) => money(o.total), align: "end" },
];
