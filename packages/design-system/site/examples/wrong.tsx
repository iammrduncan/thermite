import { Act, Failure, Wrong } from "@ds";

export default function SomethingIsWrongNow() {
  return (
    <div className="flex flex-col gap-4">
      <Wrong said="gpu-box-1 has not reported for 12 minutes.">
        <Act>See the machine</Act>
      </Wrong>
      <Failure said="Control did not answer. It is tried again." again={() => {}} />
    </div>
  );
}
