import type { ReactNode } from "react";

/** Line icons drawn on a 24px grid, in the current text colour. Decorative: the link or button names the action. */
function Icon({ children, className = "size-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export const ProjectsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="M12 8v8M8 12h8" />
  </Icon>
);

export const ActivityIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h4l3-7 4 14 3-7h4" />
  </Icon>
);

export const AssistantIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z" />
    <path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
  </Icon>
);

export const TeamsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <path d="M15.5 5.6a3.2 3.2 0 010 5.8M17.6 14.8c1.6.7 2.6 2.3 2.9 4.7" />
  </Icon>
);

export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z" />
    <path d="M10 20.5a2.2 2.2 0 004 0" />
  </Icon>
);

export const KeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="M10.9 12.6L20 3.5M16.5 7l2.5 2.5M14 9.5l2 2" />
  </Icon>
);

export const SignOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4.5h3.5a2 2 0 012 2v11a2 2 0 01-2 2H14" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </Icon>
);

export const ArrowIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

/** The hull mark: a hull at the waterline, the yard lights below. */
export function HullMark({ className = "size-7" }: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={className}>
      <path d="M5 13h22l-3.4 12H8.4z" fill="currentColor" />
      <path d="M6.9 19.5h18.2L23.6 25H8.4z" fill="var(--color-ember)" />
      <path d="M15 5h2.2v8H15z" fill="currentColor" />
    </svg>
  );
}
