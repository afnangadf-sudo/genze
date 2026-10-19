"use client";

import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
}

export function Button({ variant = "primary", className = "", ...rest }: ButtonProps) {
  const base =
    "rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-clay text-white hover:bg-clay-dark"
      : variant === "danger"
        ? "bg-red-600/10 text-red-700 hover:bg-red-600/15 dark:text-red-400"
        : "text-stone-600 hover:bg-stone-200/60 dark:text-stone-300 dark:hover:bg-stone-800";
  return <button className={`${base} ${styles} ${className}`} {...rest} />;
}
