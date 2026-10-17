/// <reference path="./css.d.ts" />
import "./ui.css";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
/** 0 is a flat surface; 1-3 are glass, each blurrier and lifted further. */
export type Depth = "0" | "1" | "2" | "3";
export type Size = "sm" | "md" | "lg";

/** A `Table` column: `value` gives the cell text and the sort key. */
export interface Column<T> {
  label: string;
  value(row: T): string | number;
  align?: "start" | "end";
  /** `false` turns sorting off for this column. */
  sort?: boolean;
}

export { icons, type IconName } from "./icons";
export { toast } from "./toast";
export { currentTheme, setTheme, toggleTheme, type Theme } from "./theme";
