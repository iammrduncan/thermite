import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

/** One filter of a list: its name, its choices with their counts, and the ones chosen. */
export interface Facet {
  name: string;
  choices: { value: string; label: string; count?: number }[];
  chosen: string[];
  choose: (values: string[]) => void;
}

/**
 * A list's one toolbar: a line of search, then each filter as a dropdown whose choices show as
 * chips that one click removes. Every list of the dashboard has this one and no other.
 */
export function Toolbar({
  search,
  onSearch,
  placeholder,
  facets = [],
}: {
  search: string;
  onSearch: (text: string) => void;
  placeholder: string;
  facets?: Facet[];
}) {
  const chips = facets.flatMap((f) =>
    f.chosen.map((value) => ({
      facet: f,
      value,
      label: f.choices.find((c) => c.value === value)?.label ?? value,
    })),
  );
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            aria-label={placeholder}
            placeholder={placeholder}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        {facets.map((f) => (
          <DropdownMenu key={f.name}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                {f.name}
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {f.choices.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.value}
                  checked={f.chosen.includes(c.value)}
                  onCheckedChange={(on) =>
                    f.choose(on ? [...f.chosen, c.value] : f.chosen.filter((v) => v !== c.value))
                  }
                >
                  {c.label}
                  {c.count !== undefined && (
                    <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">
                      {c.count}
                    </span>
                  )}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge
              key={`${chip.facet.name}:${chip.value}`}
              variant="secondary"
              className="gap-1 pr-1"
            >
              {chip.facet.name}: {chip.label}
              <button
                type="button"
                aria-label={`Remove the filter ${chip.facet.name}: ${chip.label}`}
                className="rounded-full p-0.5 outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => chip.facet.choose(chip.facet.chosen.filter((v) => v !== chip.value))}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-muted-foreground"
            onClick={() => {
              for (const f of facets) f.choose([]);
            }}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
