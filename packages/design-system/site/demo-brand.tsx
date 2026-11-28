import { SparklesIcon } from "lucide-react";

/** Neutral gallery brand mark demonstrating the `brand` prop on `Frame` and `Lone`. */
export function GalleryMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 flex-none items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground"
    >
      Mg
    </span>
  );
}

/** Neutral gallery illustration demonstrating the `art` prop on `Lone` and `Empty`. */
export function GalleryArt({ size = "medium" }: { size?: "small" | "medium" | "large" }) {
  const dim = size === "large" ? "size-16" : size === "small" ? "size-7" : "size-12";
  const iconDim = size === "large" ? "size-7" : size === "small" ? "size-3.5" : "size-5";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex ${dim} flex-none items-center justify-center rounded-2xl bg-brand-accent-tint text-brand-accent`}
    >
      <SparklesIcon className={iconDim} />
    </span>
  );
}
