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

/** A project's name, marked like a hull number. */
export function HullName({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-stencil font-bold uppercase leading-none tracking-[0.08em] ${className}`}>{children}</span>
  );
}

const TONE_DOT: Record<Tone, string> = {
  live: "bg-sea",
  working: "bg-signal signal-pulse",
  failed: "bg-oxide",
  idle: "bg-rivet",
};

const TONE_TEXT: Record<Tone, string> = {
  live: "text-sea",
  working: "text-ink",
  failed: "text-oxide",
  idle: "text-ink-soft",
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const { label, tone } = statusInfo(status);
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-semibold ${TONE_TEXT[tone]}`}>
      <span aria-hidden className={`size-2.5 rounded-full ${TONE_DOT[tone]}`} />
      {label}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-ink text-plate hover:bg-ink/85",
  secondary: "border border-rivet bg-plate text-ink hover:border-ink",
  danger: "border border-rivet bg-plate text-oxide hover:border-oxide",
};

export function buttonClass(variant: ButtonVariant = "primary"): string {
  return `inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-sm px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[variant]}`;
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
    <div role="alert" className="border-l-4 border-oxide bg-oxide-wash px-4 py-3 text-sm">
      <p className="font-semibold text-oxide">{title}</p>
      {children && <div className="mt-1 text-ink">{children}</div>}
    </div>
  );
}

/** Small uppercase label above a value. */
export function Label({ children }: { children: ReactNode }) {
  return <span className="font-display text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">{children}</span>;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[0.8125rem] ${className}`}>{children}</span>;
}
