import { AdminGate } from './admin-gate';

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>): React.ReactNode {
  return <AdminGate>{children}</AdminGate>;
}
