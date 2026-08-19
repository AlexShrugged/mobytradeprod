"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Every conversation one click away. Rendered by the /assistant layout so
// it persists across thread navigation; router.refresh() at turn end pulls
// in new conversations and model-generated titles.
export function ConversationSidebar({
  conversations,
}: {
  conversations: { id: string; title: string }[];
}) {
  const pathname = usePathname();
  return (
    <aside className="sticky top-20 hidden max-h-[calc(100vh-6.5rem)] w-64 shrink-0 flex-col gap-3 self-start md:flex">
      <Button asChild className="w-full">
        <Link href="/assistant">
          <Plus /> New
        </Link>
      </Button>
      <nav className="flex-1 space-y-0.5 overflow-y-auto">
        {conversations.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No conversations yet
          </p>
        ) : (
          conversations.map((c) => {
            const active = pathname === `/assistant/${c.id}`;
            return (
              <Link
                key={c.id}
                href={`/assistant/${c.id}`}
                className={cn(
                  "block truncate rounded-md px-2 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {c.title}
              </Link>
            );
          })
        )}
      </nav>
    </aside>
  );
}
