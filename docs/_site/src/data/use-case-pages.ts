// The use cases, read from their pages in the documentation (use-cases/<field>/), in the order of
// the fields and then of each page's sidebar order. The overview and the home page list them.
import { getCollection } from "astro:content";
import { fields } from "./use-cases.mjs";

export interface UseCase {
  field: string;
  href: string;
  title: string;
  mode: string;
  personas: string[];
  summary: string;
  measure: string[];
}

export async function useCasePages(): Promise<UseCase[]> {
  const entries = await getCollection("docs", (e) => e.id.startsWith("use-cases/") && !!e.data.useCase);
  const fieldOrder = (key: string) => fields.findIndex((f) => f.key === key);
  return entries
    .map((e) => {
      const uc = e.data.useCase as NonNullable<typeof e.data.useCase>;
      return {
        field: e.id.split("/")[1] ?? "",
        href: `/${e.id}/`,
        title: e.data.title,
        mode: uc.mode,
        personas: uc.personas,
        summary: uc.summary,
        measure: uc.measure.split(" · "),
        order: e.data.sidebar.order ?? 0,
      };
    })
    .sort((a, b) => fieldOrder(a.field) - fieldOrder(b.field) || a.order - b.order)
    .map(({ order: _order, ...uc }) => uc);
}
