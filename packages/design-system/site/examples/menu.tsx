import { IconAct, Menu } from "@ds";
import { CircleXIcon, CopyIcon, DownloadIcon, EllipsisIcon, PencilIcon } from "lucide-react";

export default function MenuOfRareActs() {
  return (
    <Menu
      lines={[
        { label: "Rename", icon: PencilIcon, onChoose: () => {} },
        { label: "Copy the campaign", icon: CopyIcon, onChoose: () => {} },
        { label: "Export its results", icon: DownloadIcon, onChoose: () => {} },
        { label: "Close the run", icon: CircleXIcon, red: true, onChoose: () => {} },
      ]}
    >
      <IconAct icon={EllipsisIcon} label="More" />
    </Menu>
  );
}
