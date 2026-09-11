import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle }: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="label-eyebrow">{title}</p>
        {/* Hidden on a phone: in the two-column mobile grid the column is
            ~170px wide, and a 32px badge plus its gap eats a quarter of
            that — the title then wraps to three lines to make room for
            decoration. The icon is redundant anyway; the title says what
            the number is. */}
        <div className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-muted text-muted-foreground sm:flex">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-2 text-2xl leading-none font-medium tabular-nums text-foreground sm:mt-3 sm:text-[28px]">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-1.5 text-xs text-muted-foreground sm:mt-2 sm:text-sm">
          {subtitle}
        </p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary'
      : sign < 0
      ? 'text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div
      className={cn(
        'mt-1.5 flex items-start gap-1 text-xs sm:mt-2 sm:text-sm',
        tone,
      )}
    >
      {/* shrink-0 + a top margin instead of items-center: these labels
          wrap to two lines in the narrow mobile column, and centering
          would float the arrow into the middle of the text block. */}
      <Arrow className="mt-px h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
