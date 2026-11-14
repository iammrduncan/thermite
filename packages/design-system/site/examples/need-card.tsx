import { Act, NeedCard } from "@ds";

export default function ANeed() {
  return (
    <NeedCard
      who="pn-prefill-2 · its teachers ask"
      question="May the agents ship hand-edited GPU machine code in the engine?"
      note="They work on other ideas until you answer."
    >
      <Act>Not now</Act>
      <Act look="main">Answer</Act>
    </NeedCard>
  );
}
