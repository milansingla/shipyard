import type { ButtonHTMLAttributes, ReactNode } from "react";

import { statusInfo, type Tone } from "@/lib/status";
import type { DeploymentStatus } from "@/lib/types";

/**
 * SHIPYARD in stencil, painted like a hull: ink above the waterline, oxide below.
 * `waterline` continues the line far past the letters (the sign-in hero); it is
 * positioned in the same box as the paint split, so the two always line up.
 */
export function Wordmark({ className = "", waterline = false }: { className?: string; waterline?: boolean }) {
  return (
    <span className={`relative inline-block font-stencil font-extrabold uppercase leading-none tracking-[0.06em] ${className}`}>
      <span className="waterline-text block">Shipyard</span>
      {waterline && (
        <span aria-hidden className="pointer-events-none absolute -inset-x-[100vw] top-[58%] border-t border-oxide/50" />
      )}
    </span>
  );
}

/** A project's name, in the wide display face; long names wrap instead of pushing the page sideways. */
export function HullName({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`display-wide font-semibold leading-[1.05] tracking-[-0.01em] [overflow-wrap:anywhere] ${className}`}>{children}</span>
  );
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
  primary: "bg-ink text-plate shadow-[0_8px_24px_-12px_rgb(255_255_255/0.5)] hover:bg-white",
  secondary: "border border-rivet bg-white/[0.05] text-ink hover:border-white/30 hover:bg-white/[0.09]",
  danger: "border border-oxide/30 bg-oxide-wash text-oxide hover:border-oxide/70",
};

export function buttonClass(variant: ButtonVariant = "primary"): string {
  return `inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[variant]}`;
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
    <div role="alert" className="rounded-2xl border border-oxide/30 bg-oxide-wash px-4 py-3 text-sm">
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

/** The warm glow and rings behind a hero card's right side. Decorative; the card needs `relative overflow-hidden`. */
export function Glow({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute -right-24 top-1/2 size-[30rem] -translate-y-1/2 ${className}`}>
      <div className="absolute inset-[22%] rounded-full bg-[radial-gradient(circle,rgb(255_122_47/0.6),rgb(255_150_60/0.15)_55%,transparent_72%)] blur-2xl" />
      <div className="absolute inset-[34%] rounded-full bg-[radial-gradient(circle_at_35%_30%,rgb(255_196_120/0.55),rgb(255_106_40/0.35)_45%,transparent_70%)]" />
      {[4, 16, 28].map((inset) => (
        <div key={inset} className="absolute rounded-full border border-white/[0.07]" style={{ inset: `${inset}%` }} />
      ))}
    </div>
  );
}
