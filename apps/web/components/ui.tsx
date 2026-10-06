import type { ButtonHTMLAttributes, ReactNode } from "react";

import { statusInfo, type Tone } from "@/lib/status";

import { LogoMark } from "./icons";
import type { DeploymentStatus } from "@/lib/types";

/**
 * The Shipyard logo: the sailboat on a glossy tile, beside the name. Sized
 * by font size (set it on the parent). `waterline` adds a hairline of light
 * running out from under it (the sign-in hero).
 */
export function Wordmark({ className = "", waterline = false }: { className?: string; waterline?: boolean }) {
  return (
    <span className={`relative inline-flex items-center gap-[0.4em] ${className}`}>
      <LogoTile className="size-[1.45em] rounded-[0.38em]" />
      <span className="headline text-sheen pb-[0.06em] font-semibold leading-none tracking-[-0.045em]">Shipyard</span>
      {waterline && (
        <span aria-hidden className="pointer-events-none absolute -inset-x-[100vw] top-[calc(100%+1.25rem)] h-px bg-gradient-to-r from-transparent via-white/35 to-transparent" />
      )}
    </span>
  );
}

/** The sailboat on a white, softly lit tile: the app icon. */
export function LogoTile({ className = "size-11 rounded-2xl" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-gradient-to-b from-white to-[#d4d4d8] text-black shadow-[inset_0_1px_0_rgb(255_255_255),inset_0_-1px_0_rgb(0_0_0/0.15),0_8px_24px_-8px_rgb(255_255_255/0.35)] ${className}`}
    >
      <LogoMark className="size-[68%]" />
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
    "bg-gradient-to-b from-white to-[#e4e4e7] text-black shadow-[inset_0_1px_0_rgb(255_255_255),0_8px_22px_-10px_rgb(255_255_255/0.45)] hover:to-white hover:shadow-[inset_0_1px_0_rgb(255_255_255),0_10px_28px_-10px_rgb(255_255_255/0.6)]",
  secondary:
    "border border-white/[0.12] bg-white/[0.06] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] hover:border-white/25 hover:bg-white/[0.1]",
  danger:
    "border border-white/[0.14] bg-white/[0.06] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] hover:border-white/30 hover:bg-white/[0.12]",
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
    <div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-white">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-oxide" />
        {title}
      </p>
      {children && <div className="mt-1 text-ink/80">{children}</div>}
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
 * A sphere of clear glass behind a hero card's right side, with faint rings
 * around it. Decorative; the card needs `relative overflow-hidden`.
 */
export function Glow({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute -right-24 top-1/2 size-[30rem] -translate-y-1/2 ${className}`}>
      <div className="absolute inset-[18%] rounded-full bg-[radial-gradient(circle,rgb(255_255_255/0.16),rgb(255_255_255/0.04)_50%,transparent_72%)] blur-2xl" />
      <div className="absolute inset-[33%] rounded-full bg-[radial-gradient(circle_at_32%_28%,rgb(255_255_255/0.7),rgb(228_228_231/0.28)_18%,rgb(113_113_122/0.22)_45%,rgb(39_39_42/0.3)_70%,transparent_72%)] shadow-[inset_0_0_40px_rgb(255_255_255/0.08)]" />
      {[4, 16, 28].map((inset) => (
        <div key={inset} className="absolute rounded-full border border-white/[0.06]" style={{ inset: `${inset}%` }} />
      ))}
    </div>
  );
}
