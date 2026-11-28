import { Alone, Failure } from "@iammrduncan/magnesium/parts";

/** One message alone, before an app has its frame: here, a read that failed. */
export default function AMessageAlone() {
  return (
    <Alone>
      <Failure said="Control did not answer. It is tried again." again={() => {}} />
    </Alone>
  );
}
