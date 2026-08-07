import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-20 w-96" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}
