"use client";

import { ScanSearch } from "lucide-react";

import { Button } from "@/components/ui/button";

export function HtsReviewBanner({
  count,
  onStart,
}: {
  count: number;
  onStart: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50/60 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 text-sm">
        <ScanSearch className="size-4 text-amber-700 dark:text-amber-400" />
        <span>
          <span className="font-medium">{count}</span> HTS classification
          {count === 1 ? " suggestion needs" : " suggestions need"} review —
          committed codes drive audits and landed cost.
        </span>
      </div>
      <Button size="sm" onClick={onStart}>
        Start review
      </Button>
    </div>
  );
}
