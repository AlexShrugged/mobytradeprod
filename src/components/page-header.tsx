"use client";

import { Info } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The one page-title treatment: a prominent headline with the page's
// explainer tucked behind an info icon (shown on hover/focus) instead of a
// permanent paragraph under every title.
export function PageHeader({ title, info }: { title: string; info: string }) {
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`About ${title}`}
              className="mt-1 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground"
            >
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          {/* text-pretty overrides the base text-balance: balanced lines all
              stop short of the box edge, wasting width; greedy wrap fills it. */}
          <TooltipContent
            side="bottom"
            align="start"
            className="max-w-xs text-pretty"
          >
            {info}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
