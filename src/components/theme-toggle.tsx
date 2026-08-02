"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const options = [
  { value: "system", icon: Monitor },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
] as const;

const emptySubscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // true only after hydration — next-themes' `theme` is unknown during SSR
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  if (!mounted) return <div className="w-[104px] h-9" />;

  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-accent border border-border">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
            theme === opt.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title={opt.value.charAt(0).toUpperCase() + opt.value.slice(1)}
        >
          <opt.icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );
}
