import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { Button } from "../components/ui/button";
import { ContentPicker } from "../components/content-picker";

// Shared fallback-image selector for the Website and YouTube editors. The
// current image resolves by ID for display while selection goes through the
// searchable, paginated Media picker, so any ready image is reachable no
// matter how large the library grows.
export function FallbackImagePicker({
  id,
  label,
  value,
  onChange,
  disabled = false,
  csrf,
  noneLabel,
  clearLabel,
  pickerTitle,
  pickerDescription,
  pickerConfirm,
}: {
  id: string;
  label: string;
  value?: string;
  onChange: (next: string | undefined) => void;
  disabled?: boolean;
  csrf: string;
  noneLabel: string;
  clearLabel: string;
  pickerTitle: string;
  pickerDescription: string;
  pickerConfirm: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = useQuery({
    queryKey: ["asset", value],
    queryFn: () => api.asset(value!),
    enabled: Boolean(value),
  });
  return (
    <div className="flex items-center gap-2">
      <Button
        id={id}
        type="button"
        variant="outline"
        aria-label={label}
        disabled={disabled}
        onClick={() => setPickerOpen(true)}
        className="min-w-0 flex-1 justify-start truncate"
      >
        {current.data?.name ?? (current.isError ? value : noneLabel)}
      </Button>
      {value && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          onClick={() => onChange(undefined)}
        >
          <X aria-hidden="true" />
        </Button>
      )}
      <ContentPicker
        open={pickerOpen}
        mode="single"
        csrf={csrf}
        allowedTypes={["image"]}
        selectedIds={value ? [value] : []}
        title={pickerTitle}
        description={pickerDescription}
        confirmLabel={pickerConfirm}
        onConfirm={(items) => {
          onChange(items[0]?.id);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
