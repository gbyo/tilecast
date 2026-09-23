import { useState } from "react";
import { Link } from "react-router";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Item, ItemContent, ItemTitle } from "../components/ui/item";
import { Badge } from "../components/ui/badge";
import { ChevronDown } from "lucide-react";

export type UsedByItem = {
  id: string;
  name: string;
  hint?: string;
};

export type UsedByGroup = {
  label: string;
  items: UsedByItem[];
  to?: (id: string) => string;
};

function UsedByLink({
  item,
  to,
}: {
  item: UsedByItem;
  to?: (id: string) => string;
}) {
  const body = (
    <>
      {item.name}
      {item.hint && (
        <Badge variant="outline" className="ml-2">
          {item.hint}
        </Badge>
      )}
    </>
  );
  if (!to) return <span className="text-sm">{body}</span>;
  return (
    <Link
      to={to(item.id)}
      className="text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </Link>
  );
}

function UsedByRows({ group }: { group: UsedByGroup }) {
  return (
    <div className="grid gap-1">
      {group.items.map((item, index) => (
        <Item key={`${item.id}-${index}`} size="sm">
          <ItemContent>
            <ItemTitle>
              <UsedByLink item={item} to={group.to} />
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </div>
  );
}

export function UsedByPanel({
  emptyMessage = "",
  groups,
  compact = false,
}: {
  emptyMessage?: string;
  groups: UsedByGroup[];
  compact?: boolean;
}) {
  const visible = groups.filter((group) => group.items.length > 0);
  const total = visible.reduce((sum, group) => sum + group.items.length, 0);
  if (total === 0)
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  if (!compact) {
    return (
      <div className="grid gap-3">
        {visible.map((group) => (
          <div key={group.label} className="grid gap-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {group.label}
            </p>
            <UsedByRows group={group} />
          </div>
        ))}
      </div>
    );
  }
  return <CompactUsedByPanel groups={visible} total={total} />;
}

function CompactUsedByPanel({
  groups,
  total,
}: {
  groups: UsedByGroup[];
  total: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2">
      <CollapsibleTrigger className="flex cursor-pointer items-center justify-between gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="text-sm font-medium">
          Used by{" "}
          <Badge variant="secondary">
            {total} {total === 1 ? "place" : "places"}
          </Badge>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`text-muted-foreground ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3">
        {groups.map((group) => (
          <CompactUsedByGroup key={group.label} group={group} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CompactUsedByGroup({ group }: { group: UsedByGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-1">
      <CollapsibleTrigger className="flex cursor-pointer items-center justify-between gap-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">{group.label}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Badge variant="secondary">{group.items.length}</Badge>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={open ? "rotate-180" : ""}
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <UsedByRows group={group} />
      </CollapsibleContent>
    </Collapsible>
  );
}
