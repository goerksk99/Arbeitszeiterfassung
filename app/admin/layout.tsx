import type { ReactNode } from "react";
import { requireProfile } from "../../lib/auth";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireProfile("admin");
  return children;
}
