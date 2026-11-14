import {
  BellIcon,
  CircleAlertIcon,
  CpuIcon,
  FlaskConicalIcon,
  FolderIcon,
  HouseIcon,
  LibraryIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";

const ICONS = [
  { icon: HouseIcon, name: "house" },
  { icon: CpuIcon, name: "cpu" },
  { icon: LibraryIcon, name: "library" },
  { icon: FlaskConicalIcon, name: "flask-conical" },
  { icon: SettingsIcon, name: "settings" },
  { icon: SearchIcon, name: "search" },
  { icon: FolderIcon, name: "folder" },
  { icon: BellIcon, name: "bell" },
  { icon: CircleAlertIcon, name: "circle-alert" },
];

export default function Icons() {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2">
      {ICONS.map(({ icon: Icon, name }) => (
        <li key={name} className="flex items-center gap-2">
          <Icon className="size-4" />
          <span className="font-mono text-xs text-quiet">{name}</span>
        </li>
      ))}
    </ul>
  );
}
