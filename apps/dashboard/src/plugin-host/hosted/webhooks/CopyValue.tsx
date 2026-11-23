import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { toast } from "@/components/ui/toast";

/** A read-only value with a copy button, for an endpoint or a new token. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("plugins");
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => toast.add({ title: t("hosted.webhooks.copied"), type: "success" }),
      () =>
        toast.add({ title: t("hosted.webhooks.copyFailed"), type: "error" }),
    );
  };
  return (
    <InputGroup>
      <InputGroupInput
        aria-label={label}
        readOnly
        value={value}
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label={t("hosted.webhooks.copy", { label })}
          onClick={copy}
        >
          <Copy aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
