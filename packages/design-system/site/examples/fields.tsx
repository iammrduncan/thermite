import { Field, Info, Segmented, Select, TextArea, TextInput } from "@ds";
import { useState } from "react";

const MODES = [
  { value: "hill", label: "Hill climb" },
  { value: "goal", label: "Goal" },
  { value: "research", label: "Research" },
] as const;

export default function Fields() {
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("hill");
  return (
    <div className="flex max-w-[480px] flex-col gap-6">
      <Field
        label="Name"
        htmlFor="ex-name"
        help="Lower-case letters, digits and dashes. Its runs are named after it."
      >
        <TextInput id="ex-name" defaultValue="pn-decode" />
      </Field>
      <Field label="Where it runs" htmlFor="ex-where" help="The devices its runs may take.">
        <Select id="ex-where" defaultValue="Any free P100">
          <option>Any free P100</option>
          <option>gpu-box-1 · P100 0</option>
        </Select>
      </Field>
      <Field label="How it works" help="Hill climb: make one number better. Goal: reach a target.">
        <Segmented label="How it works" options={MODES} chosen={mode} onChoose={setMode} />
      </Field>
      <Field label="What to make better" htmlFor="ex-what" help="In your own words.">
        <TextArea
          id="ex-what"
          defaultValue="Decode speed on one P100, with the answers unchanged."
        />
      </Field>
      <p className="flex items-center gap-2 text-soft">
        Help is behind an "i", wherever a word needs it <Info>It shows under a pointer.</Info>
      </p>
      <Field
        label="A field that is wrong"
        htmlFor="ex-wrong"
        help="What was refused is said in words."
      >
        <TextInput id="ex-wrong" aria-invalid defaultValue="PN Decode" />
      </Field>
    </div>
  );
}
