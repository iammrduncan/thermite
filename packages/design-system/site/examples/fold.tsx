import { Fold, Group } from "@ds";

export default function Advanced() {
  return (
    <div className="max-w-[480px]">
      <Fold>
        <Group title="The judge" about="How a change is measured, and when it counts.">
          <p>It measures each change three times, and a change counts from 5% better.</p>
        </Group>
        <Group title="The agents" about="Who works on the campaign, and with which model.">
          <p>Two workers, a planner and two teachers, each on the campaign's model.</p>
        </Group>
      </Fold>
    </div>
  );
}
