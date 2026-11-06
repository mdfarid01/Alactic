import { Suspense } from "react";
import { Brand } from "@/components/layout/brand";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/dashboard/user-menu";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-muted/20">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Brand href="/dashboard" />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Suspense fallback={<Skeleton className="h-7 w-32" />}>
              <UserMenu />
            </Suspense>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</div>
    </div>
  );
}
