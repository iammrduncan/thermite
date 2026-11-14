import { Act, Empty, Loading, Nothing } from "@ds";

export default function EmptyAndLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Empty action={<Act look="main">Plan with Thermy</Act>}>
        No campaign yet. Thermy can plan the first one with you.
      </Empty>
      <Nothing>Nothing waits for you. The campaigns go on by themselves.</Nothing>
      <Loading what="Loading the campaigns" />
    </div>
  );
}
