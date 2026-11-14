import { Act, IconAct, TextLink } from "@ds";
import { EllipsisIcon, EyeIcon, PlayIcon } from "lucide-react";

export default function Buttons() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <Act look="main" icon={PlayIcon}>
        Start a run
      </Act>
      <Act icon={EyeIcon}>Watch</Act>
      <Act>Not now</Act>
      <Act look="red">Close the run</Act>
      <Act look="text">Undo</Act>
      <IconAct icon={EllipsisIcon} label="More" />
      <TextLink href="#">All 214 ideas</TextLink>
      <Act look="main" disabled>
        Sign in
      </Act>
    </div>
  );
}
