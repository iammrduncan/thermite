import { CopyId, Mark, Thermy } from "@ds";

export default function MarkAndThermy() {
  return (
    <div className="flex flex-wrap items-center gap-10">
      <span className="flex items-center gap-2 text-base font-semibold">
        <Mark /> Thermite
      </span>
      <Thermy size="large" />
      <Thermy />
      <Thermy size="small" />
      <CopyId id="run-0007" label="the run's ID" />
    </div>
  );
}
