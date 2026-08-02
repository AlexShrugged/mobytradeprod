"use client";

// Click-to-edit table cell, mirroring the legacy platform's interaction:
// single click opens a focused input, blur or Enter commits, one PATCH per
// field. Deliberate departures from legacy: Escape cancels, failures surface
// as a toast (legacy failed silently), and the row refreshes from the server
// after a save instead of showing a stale value.

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

export function EditableCell({
  endpoint,
  field,
  value,
  display,
  type = "text",
  placeholder = "Click to add",
  className,
  inputClassName,
}: {
  /** PATCH target; body is { [field]: value | null }. */
  endpoint: string;
  field: string;
  /** Raw editable value ("" when unset). */
  value: string;
  /** Formatted representation shown outside edit mode. */
  display?: React.ReactNode;
  type?: "text" | "number";
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  const cancelled = React.useRef(false);

  const begin = () => {
    setDraft(value);
    cancelled.current = false;
    setEditing(true);
  };

  const commit = async () => {
    setEditing(false);
    if (cancelled.current || draft === value) return;
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: draft.trim() === "" ? null : draft.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? `Could not save ${field}.`);
        return;
      }
      router.refresh();
    } catch {
      toast.error(`Could not save ${field}.`);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        type={type}
        autoFocus
        defaultValue={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        step={type === "number" ? "0.01" : undefined}
        className={cn(
          "w-full min-w-16 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring",
          inputClassName,
        )}
      />
    );
  }

  const empty = value === "" && display === undefined;
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (!saving) begin();
      }}
      title="Click to edit"
      className={cn(
        "cursor-pointer rounded px-1 py-0.5 hover:bg-muted/60",
        saving && "opacity-50",
        empty && "text-muted-foreground italic",
        className,
      )}
    >
      {empty ? placeholder : (display ?? value)}
    </div>
  );
}
