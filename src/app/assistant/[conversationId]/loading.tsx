import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Skeleton className="mx-auto h-6 w-64" />
      <Skeleton className="h-16 w-3/4" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
