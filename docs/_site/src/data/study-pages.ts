// The case studies, read from their pages in the documentation (studies/), in their sidebar order.
// The Case studies page gives each one a card.
import { getCollection } from "astro:content";

export interface Study {
  href: string;
  title: string;
  field: string;
  personas: string[];
  modes: string[];
  metric: string;
  metricLabel: string;
  summary: string;
  partner?: string;
}

export async function studyPages(): Promise<Study[]> {
  const entries = await getCollection("docs", (e) => e.id.startsWith("studies/") && !!e.data.study);
  return entries
    .sort((a, b) => (a.data.sidebar.order ?? 0) - (b.data.sidebar.order ?? 0))
    .map((e) => {
      const s = e.data.study as NonNullable<typeof e.data.study>;
      return { href: `/${e.id}/`, title: e.data.title, ...s };
    });
}
