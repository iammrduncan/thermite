import type { ComponentProps, ReactNode } from "react";

/**
 * A standalone centered card page (such as sign-in or first-run setup): optional artwork and
 * brand mark, the app's name, its headline sentence, and its form or content.
 */
export function Lone({
  kind = "form",
  art,
  brand,
  name,
  sentence,
  children,
}: {
  /** Screen kind for layout context. */
  kind?: "form" | "detail";
  /** Optional illustration above the product title. */
  art?: ReactNode;
  /** Optional brand mark rendered beside the product name. */
  brand?: ReactNode;
  name: string;
  sentence: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-6 py-10">
      <div
        data-screen={kind}
        className="flex w-full max-w-[400px] flex-col gap-6 rounded-xl border bg-card p-6 shadow-page sm:p-10"
      >
        <div className="flex flex-col items-center gap-4">
          {art}
          <div className="flex items-center gap-2 text-base font-semibold">
            {brand}
            {name}
          </div>
        </div>
        <h1 className="text-center text-sentence">{sentence}</h1>
        {children}
      </div>
    </main>
  );
}

/** A page holding a single centered message before the app mounts its frame (e.g. fatal error). */
export function Alone({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-[480px] content-center px-4">{children}</main>
  );
}

/** A single-column form layout with 24 px vertical spacing. */
export function Form(props: Omit<ComponentProps<"form">, "className">) {
  return <form className="flex flex-col gap-6" {...props} />;
}

/** Form-level error text rendered above the action row. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="font-semibold text-wrong">
      {children}
    </p>
  );
}

/** A row of actions: secondary actions first, primary action last. */
export function Acts({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
