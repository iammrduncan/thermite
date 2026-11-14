import { Chip, Facts, Mono } from "@ds";

export default function FactsOfAThing() {
  return (
    <Facts
      facts={[
        { label: "Mode", value: "Hill climb" },
        {
          label: "The score",
          value: (
            <>
              <Mono>prefill_tps</Mono> · higher is better
            </>
          ),
        },
        { label: "Runs on", value: "one P100 for the judge, one for the workers" },
        { label: "Workers", value: <Chip state={{ word: "Working", tone: "working" }} /> },
        { label: "Started", value: "Nov 1, 14:12 UTC · day 9" },
      ]}
    />
  );
}
