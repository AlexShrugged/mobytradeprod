import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LineItemDetail } from "@/lib/db/queries/entries";
import { formatMoney, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";

// The deepest financial surface: declared charges vs the calculator's
// expectations for one 7501 line. Self-contained on purpose — swapping the
// drill-down to a sheet or page later touches only this file's caller.

const chargeTypeMeta: Record<string, { label: string; tone: string }> = {
  base_duty: { label: "Base duty", tone: "text-foreground" },
  additional_duty: { label: "Additional duty", tone: "text-amber-700 dark:text-amber-400" },
  antidumping: { label: "Antidumping", tone: "text-red-700 dark:text-red-400" },
  countervailing: { label: "Countervailing", tone: "text-red-700 dark:text-red-400" },
  mpf: { label: "MPF", tone: "text-muted-foreground" },
  hmf: { label: "HMF", tone: "text-muted-foreground" },
  other_fee: { label: "Fee", tone: "text-muted-foreground" },
};

export function LineCharges({ line }: { line: LineItemDetail }) {
  return (
    <div className="flex flex-col gap-2 bg-muted/30 px-12 py-4">
      <h4 className="text-sm font-medium">
        Charges — line {line.lineNumber}
        {line.sku ? ` · ${line.sku}` : ""}
      </h4>
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Charge</TableHead>
              <TableHead>Program / HTS</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Findings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {line.charges.map((c) => {
              const meta = chargeTypeMeta[c.chargeType] ?? {
                label: c.chargeType,
                tone: "text-foreground",
              };
              const isExclusion = Number(c.amount) === 0;
              return (
                <TableRow key={c.id}>
                  <TableCell className={cn("font-medium", meta.tone)}>
                    {meta.label}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.htsCode ?? "—"}
                    {c.measureName ? (
                      <span className="block text-xs">{c.measureName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRate(c.rate)}
                    {c.rateMismatch && c.expectedRate !== null ? (
                      <span className="block text-xs text-red-600 dark:text-red-400">
                        exp {formatRate(c.expectedRate)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(c.amount)}
                    {c.amountMismatch && c.expectedAmount !== null ? (
                      <span className="block text-xs text-red-600 dark:text-red-400">
                        exp {formatMoney(c.expectedAmount)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {isExclusion ? (
                        <Badge variant="outline" className="font-normal">
                          exclusion claimed
                        </Badge>
                      ) : null}
                      {c.rateMismatch ? (
                        <Badge
                          variant="outline"
                          className="border-red-300 font-normal text-red-700 dark:border-red-800 dark:text-red-400"
                        >
                          rate mismatch
                        </Badge>
                      ) : null}
                      {c.amountMismatch ? (
                        <Badge
                          variant="outline"
                          className="border-red-300 font-normal text-red-700 dark:border-red-800 dark:text-red-400"
                        >
                          amount mismatch
                        </Badge>
                      ) : null}
                      {c.suppressedReason ? (
                        <Badge
                          variant="outline"
                          className="border-amber-300 font-normal text-amber-700 dark:border-amber-800 dark:text-amber-400"
                          title={c.suppressedReason}
                        >
                          should not apply
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {line.missingMeasures.map((m) => (
              <TableRow key={m.ch99Code} className="bg-amber-50/50 dark:bg-amber-950/20">
                <TableCell className="font-medium text-amber-700 dark:text-amber-400">
                  Expected — not declared
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {m.ch99Code}
                  <span className="block text-xs">{m.name}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatRate(m.rate)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatMoney(m.expectedAmount)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-amber-300 font-normal text-amber-700 dark:border-amber-800 dark:text-amber-400"
                  >
                    missing measure
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {line.charges.length === 0 && line.missingMeasures.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-16 text-center text-muted-foreground"
                >
                  No charges ingested for this line.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <p className="text-right text-xs text-muted-foreground">
        Line landed cost = entered value + charges above:{" "}
        <span className="font-medium tabular-nums text-foreground">
          {formatMoney(line.landedValue)}
        </span>
        {line.landedPerUnit !== null ? (
          <> · {formatMoney(line.landedPerUnit)}/unit</>
        ) : null}
      </p>
    </div>
  );
}
