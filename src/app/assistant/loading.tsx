import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex min-h-[55vh] w-full max-w-2xl flex-col items-center justify-center gap-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
