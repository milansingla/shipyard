import type { ButtonHTMLAttributes, ReactNode } from "react";

import { statusInfo, type Tone } from "@/lib/status";
import type { DeploymentStatus } from "@/lib/types";

/**
 * The Shipyard name, lit from above. `waterline` adds a hairline of accent
 * light running out from under the letters (the sign-in hero).
 */
export function Wordmark({ className = "", waterline = false }: { className?: string; waterline?: boolean }) {
  return (
    <span className={`headline relative inline-block font-semibold leading-none ${className}`}>
      <span className="text-sheen block pb-[0.08em]">Shipyard</span>
      {waterline && (
        <span aria-hidden className="pointer-events-none absolute -inset-x-[100vw] top-[112%] h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />
      )}
    </span>
  );
}

/**
 * A project's name, in the display face. Long names wrap after "_", "-" or "."
 * (word-like breaks, <wbr>, so copying still gives the exact name), and only
 * mid-word as a last resort.
 */
export function HullName({ children, className = "" }: { children: ReactNode; className?: string }) {
  const content =
    typeof children === "string"
      ? children.split(/(?<=[_\-.])/).flatMap((part, index) => (index === 0 ? [part] : [<wbr key={index} />, part]))
      : children;
  return <span className={`headline font-semibold leading-[1.08] [overflow-wrap:break-word] ${className}`}>{content}</span>;
}

const TONE_DOT: Record<Tone, string> = {
  live: "bg-sea",
  working: "bg-signal signal-pulse",
  failed: "bg-oxide",
  idle: "bg-rivet",
};

const TONE_TEXT: Record<Tone, string> = {
  live: "text-sea bg-sea-wash",
  working: "text-signal bg-signal/10",
  failed: "text-oxide bg-oxide-wash",
  idle: "text-ink-soft bg-white/[0.06]",
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const { label, tone } = statusInfo(status);
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_TEXT[tone]}`}>
      <span aria-hidden className={`size-2 rounded-full ${TONE_DOT[tone]}`} />
      {label}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-b from-[#5d95ff] to-accent-strong text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_8px_20px_-8px_rgb(79_139_255/0.65)] hover:from-[#6ea1ff] hover:to-accent hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_10px_26px_-8px_rgb(79_139_255/0.8)]",
  secondary:
    "border border-white/[0.12] bg-white/[0.06] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] hover:border-white/25 hover:bg-white/[0.1]",
  danger: "border border-oxide/25 bg-oxide-wash text-oxide hover:border-oxide/60 hover:bg-oxide/15",
};

export function buttonClass(variant: ButtonVariant = "primary"): string {
  return `inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-sm font-medium active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${BUTTON[variant]}`;
}

export function Button({
  variant = "primary",
  busy = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  return (
    <button type="button" {...props} disabled={props.disabled || busy} aria-busy={busy} className={buttonClass(variant)}>
      {children}
    </button>
  );
}

/** An error the user can act on: what happened, in the API's own words. */
export function ErrorNote({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-2xl border border-oxide/25 bg-oxide-wash px-4 py-3 text-sm">
      <p className="font-semibold text-oxide">{title}</p>
      {children && <div className="mt-1 text-ink">{children}</div>}
    </div>
  );
}

/** Small uppercase label above a value. */
export function Label({ children }: { children: ReactNode }) {
  return <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-soft">{children}</span>;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[0.8125rem] ${className}`}>{children}</span>;
}

/**
 * A sphere of liquid glass behind a hero card's right side, with faint rings
 * around it. Decorative; the card needs `relative overflow-hidden`.
 */
export function Glow({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute -right-24 top-1/2 size-[30rem] -translate-y-1/2 ${className}`}>
      <div className="absolute inset-[18%] rounded-full bg-[radial-gradient(circle,rgb(79_139_255/0.45),rgb(139_92_246/0.18)_50%,transparent_72%)] blur-2xl" />
      <div className="absolute inset-[33%] rounded-full bg-[radial-gradient(circle_at_32%_28%,rgb(255_255_255/0.55),rgb(147_180_255/0.35)_18%,rgb(79_110_230/0.35)_45%,rgb(91_60_200/0.25)_70%,transparent_72%)] shadow-[inset_0_0_40px_rgb(255_255_255/0.08)]" />
      {[4, 16, 28].map((inset) => (
        <div key={inset} className="absolute rounded-full border border-white/[0.06]" style={{ inset: `${inset}%` }} />
      ))}
    </div>
  );
}
