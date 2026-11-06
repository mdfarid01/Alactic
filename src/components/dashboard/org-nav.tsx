"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; disabled?: boolean };

export function OrgNav({ orgSlug }: { orgSlug: string }) {
  const pathname = usePathname();
  const base = `/dashboard/${orgSlug}`;
  const items: Item[] = [
    { href: base, label: "Overview" },
    { href: `${base}/agents`, label: "Agents" },
    { href: `${base}/members`, label: "Members" },
  ];
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Organization">
      {items.map((item) => {
        const active = item.href === base ? pathname === base : pathname.startsWith(item.href);
        if (item.disabled) {
          return (
            <span
              key={item.href}
              aria-disabled
              title="Available in the next release"
              className="cursor-not-allowed border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground/60"
            >
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "border-b-2 px-3 py-2 text-sm transition-colors",
              active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
