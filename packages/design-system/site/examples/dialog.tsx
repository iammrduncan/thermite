import { Act, Confirm } from "@ds";
import { useState } from "react";

export default function TheOneDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Act look="red" onClick={() => setOpen(true)}>
        Close the run
      </Act>
      <Confirm
        open={open}
        onOpenChange={setOpen}
        title="Close pn-prefill-2?"
        text="Its workers stop now, and the 2 changes the judge measures are dropped. Its results and its best change stay."
        keep="Keep it running"
        lose="Close the run"
        onLose={() => {}}
      />
    </>
  );
}
