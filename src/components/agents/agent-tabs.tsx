"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function AgentTabs({ base }: { base: string }) {
  const pathname = usePathname();
  const items = [
    { href: base, label: "Configuration", active: pathname === base },
    { href: `${base}/knowledge`, label: "Knowledge", active: pathname.startsWith(`${base}/knowledge`) },
  ];
  return (
    <nav aria-label="Agent" className="flex gap-1 rounded-lg bg-muted p-1 text-sm w-fit">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.active ? "page" : undefined}
          className={cn("rounded-md px-3 py-1", i.active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
