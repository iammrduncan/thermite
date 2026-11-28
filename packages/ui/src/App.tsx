import { Chip, Empty, Frame, NavLine, Screen, Section } from "@iammrduncan/magnesium/parts";
import { Badge, Button } from "@iammrduncan/magnesium/primitives";
import { THERMITE_VERSION } from "@thermite/core";
import { BookOpenIcon, CpuIcon, FlaskConicalIcon, HomeIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { Mark, Thermy } from "./brand/index.ts";

const NAV_ITEMS = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "compute", label: "Compute", icon: CpuIcon },
  { id: "knowledge", label: "Knowledge", icon: BookOpenIcon },
  { id: "campaigns", label: "Campaigns", icon: FlaskConicalIcon },
  { id: "setup", label: "Setup", icon: SettingsIcon },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

export function App() {
  const [active, setActive] = useState<NavId>("home");

  return (
    <Frame
      name="Thermite"
      brand={<Mark />}
      home="#home"
      onHome={(e) => {
        e.preventDefault();
        setActive("home");
      }}
      nav={NAV_ITEMS.map((item) => (
        <NavLine
          key={item.id}
          href={`#${item.id}`}
          icon={item.icon}
          label={item.label}
          chosen={active === item.id}
          onClick={(e) => {
            e.preventDefault();
            setActive(item.id);
          }}
        />
      ))}
    >
      <Screen
        kind="home"
        title="Thermite"
        state={<Chip tone="good">Ready</Chip>}
        sentence="Agents propose changes; code they cannot touch measures and promotes them."
      >
        <Section title="Workspace">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">v{THERMITE_VERSION}</Badge>
            <Button type="button" onClick={() => setActive("campaigns")}>
              Open campaigns
            </Button>
          </div>
          <Empty art={<Thermy size="medium" />}>
            No active runs yet. Start a campaign once Control is connected.
          </Empty>
        </Section>
      </Screen>
    </Frame>
  );
}
