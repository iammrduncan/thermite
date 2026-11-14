export default function Type() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sentence">22 px, the screen's one sentence: text-sentence</p>
      <p className="text-base font-semibold">
        16 px in 600, a block's title: text-base font-semibold
      </p>
      <p className="font-semibold">14 px in 600, a name: text-sm font-semibold</p>
      <p>14 px, text: text-sm</p>
      <p className="text-xs text-quiet">12 px, quiet facts, a table's heads: text-xs text-quiet</p>
      <p className="font-mono text-xs">
        Geist Mono 12 px, what a person may copy: font-mono text-xs
      </p>
    </div>
  );
}
