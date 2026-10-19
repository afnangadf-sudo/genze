"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  children?: ReactNode;
}

/** Labeled input primitive. Pass <select> as children for dropdowns. */
export function Field({ label, hint, children, id, className = "", ...rest }: FieldProps) {
  const inputClass =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-800 " +
    "placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay " +
    "dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300">{label}</span>
      {children ? (
        <span className={`block ${className}`}>{children}</span>
      ) : (
        <input id={id} className={`${inputClass} ${className}`} {...rest} />
      )}
      {hint && <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">{hint}</span>}
    </label>
  );
}

export const fieldInputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-800 " +
  "placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay " +
  "dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500";
