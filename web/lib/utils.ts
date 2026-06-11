/** Fusion de classes : clsx pour le conditionnel + tailwind-merge pour dédupliquer. */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
