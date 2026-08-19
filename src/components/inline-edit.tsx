"use client";

// Click-to-edit table cell, mirroring the legacy platform's interaction:
// single click opens a focused input, blur or Enter commits, one PATCH per
// field. Deliberate departures from legacy: Escape cancels, failures surface
// as a toast (legacy failed silently), and the row refreshes from the server
// after a save instead of showing a stale value.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
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
  expandOnEdit = false,
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
  /** For width-capped cells: the edit input floats over the columns to the
   *  right at a fixed wide size, so a truncated value is editable in full
   *  without reflowing the table. */
  expandOnEdit?: boolean;
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
    const input = (
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
          expandOnEdit &&
            "absolute inset-y-0 left-0 z-10 w-[32rem] max-w-[75vw] shadow-md",
          inputClassName,
        )}
      />
    );
    if (!expandOnEdit) return input;
    return (
      <div className={cn("relative", className)}>
        {/* Invisible copy of the display content holds the cell's exact
            footprint while the input floats above it. */}
        <div
          className="invisible flex items-center gap-1.5 px-1 py-0.5 text-sm"
          aria-hidden
        >
          <span className="truncate">{value === "" ? placeholder : value}</span>
        </div>
        {input}
      </div>
    );
  }

  const empty = value === "" && display === undefined;
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (!saving) begin();
      }}
      // The full value on hover — the visible text may be truncated by a
      // width-capped cell. The pencil already signals editability.
      title={value === "" ? "Click to edit" : value}
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/60",
        saving && "opacity-50",
        empty && "text-muted-foreground italic",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        {empty ? placeholder : (display ?? value)}
      </span>
      {/* The editability signal — always faintly present, full on hover. */}
      <Pencil
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}
