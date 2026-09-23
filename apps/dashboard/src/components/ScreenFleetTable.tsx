import { useMemo } from "react";
import {
  createColumnHelper,
  rowSelectionFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  CircleAlert,
  Ellipsis,
  Monitor,
  Pencil,
  Play,
  RefreshCw,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { Screen, ScreenStatus } from "../api/types";
import { api } from "../api/client";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

const features = tableFeatures({ rowSelectionFeature });
const columnHelper = createColumnHelper<typeof features, Screen>();

const statusLabels: Record<ScreenStatus, string> = {
  online: "Online",
  recent: "Recently online",
  stale: "Stale",
  offline: "Offline",
  disabled: "Disabled",
  revoked: "Pairing revoked",
};

export function ScreenFleetTable({
  screens,
  canManage,
  selectedIds,
  csrfToken,
  onSelectionChange,
}: {
  screens: Screen[];
  canManage: boolean;
  selectedIds: Set<string>;
  csrfToken: string;
  onSelectionChange: (id: string, selected: boolean) => void;
}) {
  const navigate = useNavigate();
  const rowSelection = useMemo<Record<string, true>>(
    () =>
      [...selectedIds].reduce<Record<string, true>>((selection, id) => {
        selection[id] = true;
        return selection;
      }, {}),
    [selectedIds],
  );
  const columns = useMemo(
    () =>
      columnHelper.columns([
        ...(canManage
          ? [
              columnHelper.display({
                id: "select",
                header: "",
                cell: ({ row }) => (
                  <Checkbox
                    aria-label={`Select ${row.original.name}`}
                    checked={row.getIsSelected()}
                    onCheckedChange={(checked) =>
                      row.toggleSelected(checked === true)
                    }
                  />
                ),
              }),
            ]
          : []),
        columnHelper.display({
          id: "screen",
          header: "Screen",
          cell: ({ row }) => {
            const screen = row.original;
            return (
              <div className="flex min-w-48 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Monitor className="size-4" aria-hidden="true" />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <Link
                    to={`/screens/${screen.id}`}
                    className="max-w-64 truncate font-medium text-foreground hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {screen.name}
                  </Link>
                  <span className="max-w-72 truncate text-xs text-muted-foreground">
                    {[
                      screen.roomName,
                      screen.roomNumber ? `Room ${screen.roomNumber}` : "",
                      screen.syncGroupName,
                    ]
                      .filter(Boolean)
                      .join(" · ") ||
                      screen.description ||
                      "No additional details"}
                  </span>
                </span>
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "status",
          header: "Status",
          cell: ({ row }) => {
            const screen = row.original;
            return (
              <div className="grid justify-items-start gap-1">
                <StatusBadge status={screen.status} />
                {screen.updateError && (
                  <Badge variant="destructive" className="gap-1">
                    <CircleAlert aria-hidden="true" /> Update failed
                  </Badge>
                )}
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "playing",
          header: "Now playing",
          cell: ({ row }) => (
            <div className="max-w-56">
              <div className="truncate font-medium">
                {row.original.nowPlayingName || "Nothing assigned"}
              </div>
              <div className="text-xs text-muted-foreground">
                {row.original.nowPlayingName
                  ? row.original.nowPlayingType === "playlist"
                    ? "Playlist"
                    : "Presentation"
                  : "No fallback content"}
              </div>
            </div>
          ),
        }),
        columnHelper.display({
          id: "location",
          header: "Location",
          cell: ({ row }) => (
            <div className="max-w-40 truncate text-muted-foreground">
              {row.original.location || "Not set"}
            </div>
          ),
        }),
        columnHelper.display({
          id: "platform",
          header: "Platform / device",
          cell: ({ row }) => (
            <div className="max-w-48">
              <div className="truncate">
                {platformLabel(row.original.platform)}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {[
                  [row.original.deviceManufacturer, row.original.deviceModel]
                    .filter(Boolean)
                    .join(" "),
                  row.original.screenWidth && row.original.screenHeight
                    ? `${row.original.screenWidth}×${row.original.screenHeight}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "Device not reported"}
              </div>
            </div>
          ),
        }),
        columnHelper.display({
          id: "version",
          header: "Player version",
          cell: ({ row }) => (
            <div className="max-w-40">
              <div className="truncate">
                {row.original.playerVersion || "Not reported"}
              </div>
              {row.original.updateState && (
                <div className="truncate text-xs text-muted-foreground">
                  {humanize(row.original.updateState)}
                </div>
              )}
            </div>
          ),
        }),
        columnHelper.display({
          id: "lastSeen",
          header: "Last seen",
          cell: ({ row }) => (
            <time
              className="text-muted-foreground"
              dateTime={row.original.lastContactAt}
              title={
                row.original.lastContactAt
                  ? new Date(row.original.lastContactAt).toLocaleString()
                  : undefined
              }
            >
              {formatContact(row.original.lastContactAt)}
            </time>
          ),
        }),
        ...(canManage
          ? [
              columnHelper.display({
                id: "actions",
                header: "",
                cell: ({ row }) => (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                      aria-label={`Actions for ${row.original.name}`}
                    >
                      <Ellipsis aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        render={<Link to={`/screens/${row.original.id}`} />}
                      >
                        <Monitor aria-hidden="true" /> Open screen
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void api.createScreenCommand(
                            row.original.id,
                            "restart_player_process",
                            {},
                            csrfToken,
                          )
                        }
                      >
                        <RefreshCw aria-hidden="true" /> Restart player
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={
                          <Link
                            to={`/screens/${row.original.id}?tab=content`}
                          />
                        }
                      >
                        <Pencil aria-hidden="true" /> Assign content
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={
                          <Link
                            to={`/screens/${row.original.id}?edit=details`}
                          />
                        }
                      >
                        <Pencil aria-hidden="true" /> Edit details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={
                          <Link to={`/screens/${row.original.id}?present=1`} />
                        }
                      >
                        <Play aria-hidden="true" /> Show now
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() =>
                          void navigate(
                            row.original.syncGroupId
                              ? `/groups/${row.original.syncGroupId}`
                              : "/groups",
                          )
                        }
                      >
                        {row.original.syncGroupId
                          ? "Open Display Group"
                          : "Add to Display Group"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ),
              }),
            ]
          : []),
      ]),
    [canManage, csrfToken, navigate],
  );
  const table = useTable({
    features,
    columns,
    data: screens,
    getRowId: (row) => row.id,
    state: { rowSelection },
    onRowSelectionChange: (updater) => {
      const nextSelection =
        typeof updater === "function" ? updater(rowSelection) : updater;
      for (const screen of screens) {
        const wasSelected = rowSelection[screen.id] === true;
        const isSelected = nextSelection[screen.id] === true;
        if (wasSelected !== isSelected) {
          onSelectionChange(screen.id, isSelected);
        }
      }
    },
  });

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border">
      <Table className="min-w-[1000px]">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className="bg-muted/40 text-xs text-muted-foreground"
                >
                  {header.isPlaceholder ? null : (
                    <table.FlexRender header={header} />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() ? "selected" : undefined}
              className="h-[4.25rem]"
            >
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className="px-2.5 py-2">
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ status }: { status: ScreenStatus }) {
  const variant =
    status === "offline" || status === "stale"
      ? "destructive"
      : status === "recent"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{statusLabels[status] ?? "Unknown"}</Badge>;
}

function platformLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "linux") return "Linux";
  if (normalized.includes("fire")) return "Fire TV";
  if (normalized.includes("google")) return "Google TV";
  if (normalized.includes("android")) return "Android TV";
  return value || "Unknown platform";
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatContact(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
