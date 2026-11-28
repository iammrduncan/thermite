import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@iammrduncan/magnesium/primitives";
import { ChevronsUpDownIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

export default function SyncedPrimitives() {
  const [live, setLive] = useState(true);
  const [checked, setChecked] = useState(true);
  const [open, setOpen] = useState(false);

  return (
    <div className="grid gap-6 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Avatar>
          <AvatarFallback>MG</AvatarFallback>
        </Avatar>
      </div>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2 text-sm">
            <label htmlFor="prim-live">Publish live stream</label>
            <Switch id="prim-live" checked={live} onCheckedChange={setLive} />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="prim-promote"
              checked={checked}
              onCheckedChange={(v) => setChecked(v === true)}
            />
            <label htmlFor="prim-promote">Auto-promote verified champions</label>
          </div>
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <SearchIcon className="size-4" />
            </InputGroupAddon>
            <InputGroupInput placeholder="Filter metrics or runs…" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="xs">Go</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>

        <div className="grid gap-3">
          <NativeSelect defaultValue="cuda" className="w-full">
            <NativeSelectOption value="cuda">device-cuda (NVIDIA)</NativeSelectOption>
            <NativeSelectOption value="metal">device-metal (Apple Silicon)</NativeSelectOption>
            <NativeSelectOption value="cpu">device-cpu (Host)</NativeSelectOption>
          </NativeSelect>
          <Input placeholder="Standard radix-nova Input" />
          <Textarea placeholder="Auto-sizing radix-nova Textarea…" rows={2} />
        </div>
      </div>

      <Separator />

      <div className="flex flex-wrap items-start gap-6">
        <Tabs defaultValue="summary" className="min-w-60 flex-1">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="pt-2 text-sm text-soft">
            Tabs primitive rendered with active preset styling.
          </TabsContent>
          <TabsContent value="metrics" className="pt-2 text-sm text-soft">
            Throughput +14.2%, accuracy within guard threshold.
          </TabsContent>
        </Tabs>

        <div className="flex flex-wrap items-center gap-3">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                Open popover
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-60 text-sm">
              Popover surface uses preset card/popover tokens and radius.
            </PopoverContent>
          </Popover>

          <Collapsible open={open} onOpenChange={setOpen} className="w-56">
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-between">
                Details <ChevronsUpDownIcon className="size-3.5" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 rounded-md border p-2 text-xs text-soft">
              Collapsible primitive body content.
            </CollapsibleContent>
          </Collapsible>

          <div className="flex items-center gap-2">
            <Skeleton className="size-8 rounded-full" />
            <div className="grid gap-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
