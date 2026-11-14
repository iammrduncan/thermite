import type { ComponentProps, ReactNode } from "react";
import { Mark } from "../brand/mark.tsx";

/**
 * A page with one thing on it and nothing around it, such as the sign-in: a card on the
 * sidebar's paper, with a picture, the app's name, its one sentence, and what it asks.
 */
export function Lone({
  kind = "form",
  art,
  name,
  sentence,
  children,
}: {
  /** The kind of screen, for its budget: a form unless said. */
  kind?: "form" | "detail";
  /** A picture over the name, such as Thermy. */
  art?: ReactNode;
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
            <Mark />
            {name}
          </div>
        </div>
        <h1 className="text-center text-sentence">{sentence}</h1>
        {children}
      </div>
    </main>
  );
}

/** A page that holds one message alone, before an app has its frame: a fault, or a wait. */
export function Alone({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-[480px] content-center px-4">{children}</main>
  );
}

/** A form: its fields in one column, 24 px apart, then its buttons. */
export function Form(props: Omit<ComponentProps<"form">, "className">) {
  return <form className="flex flex-col gap-6" {...props} />;
}

/** Why a form was refused, in the server's own words, over its buttons. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="font-semibold text-wrong">
      {children}
    </p>
  );
}

/** A row of buttons: plain ones first, the main one last. */
export function Acts({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
