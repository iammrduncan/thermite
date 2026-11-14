import { Count, NavAccount, NavItem, NavLine, NavList } from "@ds";
import { CpuIcon, FlaskConicalIcon, HouseIcon, PlusIcon, SettingsIcon } from "lucide-react";

export default function SidebarLines() {
  return (
    <div className="flex max-w-[256px] flex-col gap-1 rounded-xl border bg-sidebar p-2">
      <NavLine href="#" icon={HouseIcon} label="Home" chosen end={<Count>2</Count>} />
      <NavLine href="#" icon={CpuIcon} label="Compute" out title="Compute opens elsewhere" />
      <NavLine
        href="#"
        icon={FlaskConicalIcon}
        label="Campaigns"
        beside={{ href: "#", icon: PlusIcon, label: "New campaign" }}
      />
      <NavList>
        <NavItem href="#" tone="working" label="pn-prefill" word="+57%" />
        <NavItem href="#" tone="none" label="pn-quality" word="paused" />
      </NavList>
      <NavLine href="#" icon={SettingsIcon} label="Setup" />
      <NavAccount name="shannon" onSignOut={() => {}} />
    </div>
  );
}
