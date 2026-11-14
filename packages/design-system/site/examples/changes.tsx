import { Change } from "@ds";

export default function Changes() {
  return (
    <div className="flex flex-wrap gap-10">
      <Change direction="up" better>
        57% faster
      </Change>
      <Change direction="down" better={false}>
        5.1% slower
      </Change>
      <Change direction="down" better>
        23% less time
      </Change>
      <Change direction="up" better={false}>
        12% more memory
      </Change>
    </div>
  );
}
