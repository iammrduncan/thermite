import { CopyId, PluginIcon } from "@iammrduncan/magnesium/parts";
import { GalleryArt, GalleryMark } from "../demo-brand.tsx";

export default function BrandSlotsAndIds() {
  return (
    <div className="flex flex-wrap items-center gap-8">
      <span className="flex items-center gap-2 text-base font-semibold">
        <GalleryMark /> Host brand slot
      </span>
      <GalleryArt size="medium" />
      <div className="flex items-center gap-2">
        <PluginIcon iconKey="com.usethermite/git-sync" size={32} />
        <PluginIcon iconKey="com.usethermite/web-pairing" size={32} />
        <PluginIcon iconKey="com.usethermite/knowledge-semantic" size={32} />
      </div>
      <CopyId id="run-0007" label="the run's ID" />
    </div>
  );
}
