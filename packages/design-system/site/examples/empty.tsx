import { Act, Empty, Loading, Nothing } from "@iammrduncan/magnesium/parts";
import { GalleryArt } from "../demo-brand.tsx";

export default function EmptyAndLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Empty art={<GalleryArt />} action={<Act look="main">Start first run</Act>}>
        No active runs yet. Create one to begin measuring candidates.
      </Empty>
      <Nothing>Nothing waits for you. Active campaigns continue automatically.</Nothing>
      <Loading what="Loading campaigns" />
    </div>
  );
}
