import { Act, Undo } from "@ds";
import { useState } from "react";

export default function DoItAndOfferUndo() {
  const [archived, setArchived] = useState(true);
  return archived ? (
    <Undo onUndo={() => setArchived(false)}>pn-quality is archived.</Undo>
  ) : (
    <Act onClick={() => setArchived(true)}>Archive pn-quality</Act>
  );
}
