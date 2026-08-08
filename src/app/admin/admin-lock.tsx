"use client";

// Super-admin cookie login. Rendered by /admin pages when SUPER_ADMIN_SECRET
// is set and the mt_admin cookie doesn't match — with the secret unset (local
// dev) the pages never render this.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminLock() {
  const router = useRouter();
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Unlock failed.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm pt-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="size-4" /> Platform admin
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={unlock} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="admin-secret" className="text-xs">
                Admin secret
              </Label>
              <Input
                id="admin-secret"
                type="password"
                value={secret}
                disabled={busy}
                onChange={(e) => setSecret(e.target.value)}
                autoFocus
              />
            </div>
            <Button type="submit" size="sm" disabled={busy || secret.length === 0}>
              {busy ? "Unlocking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
