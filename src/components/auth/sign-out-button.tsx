"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDisconnect } from "wagmi";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function SignOutMenuItem() {
  const router = useRouter();
  const disconnect = useDisconnect();
  return (
    <DropdownMenuItem
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        disconnect.mutate();
        router.replace("/");
        router.refresh();
      }}
    >
      <LogOut />
      Sign out
    </DropdownMenuItem>
  );
}
