import { ClipboardPaste, Link, RotateCcw, UploadCloud } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StructuredSourceConfig } from "../api/types";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type CsvInputMode = "upload" | "url" | "paste";

type CsvErrorKey =
  | "widgets.csv.errors.empty"
  | "widgets.csv.errors.noColumns"
  | "widgets.csv.errors.badExtension"
  | "widgets.csv.errors.tooLarge"
  | "widgets.csv.errors.notUtf8";

export type CsvInspection = {
  columns: string[];
  delimiter: NonNullable<StructuredSourceConfig["delimiter"]>;
  rowCount: number;
};

function detectDelimiter(header: string) {
  const candidates = [",", ";", "\t", "|"] as const;
  let selected: (typeof candidates)[number] = ",";
  let highestCount = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < header.length; index += 1) {
      if (header[index] === '"') {
        if (quoted && header[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && header[index] === candidate) {
        count += 1;
      }
    }
    if (count > highestCount) {
      selected = candidate;
      highestCount = count;
    }
  }
  return selected;
}

function parseCsvRow(row: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

export function inspectCsv(content: string): CsvInspection {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const firstLine = normalized.split("\n", 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  return {
    columns: parseCsvRow(firstLine, delimiter).filter(Boolean),
    delimiter,
    rowCount: Math.max(
      0,
      normalized.split("\n").filter((line) => line.trim()).length - 1,
    ),
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`;
}

// The local inspection here summarizes the chosen file immediately. The mapping itself is
// filled from the Server's detection, which parses exactly as a refresh will.
export function CsvSourceInput({
  configuration,
  readOnly,
  onChange,
}: {
  configuration: StructuredSourceConfig;
  readOnly: boolean;
  onChange: (patch: Partial<StructuredSourceConfig>) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const inputId = useId();
  const urlId = useId();
  const pasteId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<CsvInputMode>(() =>
    configuration.uploaded
      ? "upload"
      : configuration.url && configuration.url !== "https://"
        ? "url"
        : "upload",
  );
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState<number>();
  const [inspection, setInspection] = useState<CsvInspection>();
  // The untranslated key, so a language change re-renders the alert instead
  // of freezing the message in the language that was active when it fired.
  const [error, setError] = useState<CsvErrorKey | "">("");
  const [dragging, setDragging] = useState(false);

  const applyContent = (content: string) => {
    const inspection = inspectCsv(content);
    if (!content.trim()) {
      onChange({ url: "", uploadedContent: undefined, uploaded: false });
      setError("widgets.csv.errors.empty");
      return;
    }
    if (inspection.columns.length < 1) {
      setError("widgets.csv.errors.noColumns");
      return;
    }
    setError("");
    setInspection(inspection);
    onChange({ url: "", uploadedContent: content, uploaded: true });
  };

  const readFile = async (file?: File) => {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["csv", "tsv", "txt"].includes(extension)) {
      setError("widgets.csv.errors.badExtension");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("widgets.csv.errors.tooLarge");
      return;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      setFileName(file.name);
      setFileSize(file.size);
      applyContent(content);
    } catch {
      setError("widgets.csv.errors.notUtf8");
    }
  };

  const switchMode = (nextMode: CsvInputMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setError("");
    setFileName("");
    setFileSize(undefined);
    setInspection(undefined);
    onChange({
      url: nextMode === "url" ? configuration.url || "https://" : "",
      uploadedContent: undefined,
      uploaded: false,
    });
  };

  return (
    <fieldset className="csv-source-input">
      <legend>{t("widgets.csv.connection.legend")}</legend>
      <ToggleGroup
        className="csv-source-input__modes"
        aria-label={t("widgets.csv.connection.typeLabel")}
        multiple={false}
        value={[mode]}
        onValueChange={(next) => {
          const first = next[0] as CsvInputMode | undefined;
          if (first !== undefined) switchMode(first);
        }}
      >
        <ToggleGroupItem value="upload" disabled={readOnly}>
          <UploadCloud size={15} aria-hidden="true" />{" "}
          {t("widgets.csv.mode.upload")}
        </ToggleGroupItem>
        <ToggleGroupItem value="url" disabled={readOnly}>
          <Link size={15} aria-hidden="true" /> {t("widgets.csv.mode.url")}
        </ToggleGroupItem>
        <ToggleGroupItem value="paste" disabled={readOnly}>
          <ClipboardPaste size={15} aria-hidden="true" />{" "}
          {t("widgets.csv.mode.paste")}
        </ToggleGroupItem>
      </ToggleGroup>

      {mode === "upload" && !configuration.uploaded && (
        <div
          className={`csv-dropzone${dragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!readOnly) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!readOnly) void readFile(event.dataTransfer.files[0]);
          }}
        >
          <UploadCloud size={24} />
          <span>
            <strong>{t("widgets.csv.dropzone.title")}</strong>
            <small>{t("widgets.csv.dropzone.hint")}</small>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            {t("widgets.csv.dropzone.choose")}
          </Button>
          <Input
            ref={fileInput}
            id={inputId}
            className="visually-hidden"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            disabled={readOnly}
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
        </div>
      )}

      {mode === "upload" && configuration.uploaded && (
        <Alert role="status">
          <AlertTitle>{fileName || t("widgets.csv.uploaded.ready")}</AlertTitle>
          <AlertDescription>
            {fileSize === undefined
              ? t("widgets.csv.uploaded.stored")
              : t("widgets.csv.uploaded.summary", {
                  count: inspection?.rowCount ?? 0,
                  size: formatBytes(fileSize),
                  columns: inspection?.columns?.length ?? 0,
                })}
          </AlertDescription>
          {!readOnly && (
            <AlertAction>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={t("widgets.csv.uploaded.replace")}
                aria-label={t("widgets.csv.uploaded.replace")}
                onClick={() => {
                  onChange({ uploadedContent: undefined, uploaded: false });
                  setFileName("");
                  setFileSize(undefined);
                  setInspection(undefined);
                  if (fileInput.current) fileInput.current.value = "";
                }}
              >
                <RotateCcw size={16} />
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      {mode === "url" && (
        <Field>
          <FieldLabel htmlFor={urlId}>{t("widgets.csv.url.label")}</FieldLabel>
          <Input
            id={urlId}
            type="url"
            value={configuration.url ?? ""}
            placeholder="https://example.org/menu.csv"
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                url: event.target.value,
                uploadedContent: undefined,
                uploaded: false,
              })
            }
          />
          <FieldDescription>{t("widgets.csv.url.hint")}</FieldDescription>
        </Field>
      )}

      {mode === "paste" && (
        <Field>
          <FieldLabel htmlFor={pasteId}>
            {t("widgets.csv.paste.label")}
          </FieldLabel>
          <Textarea
            id={pasteId}
            rows={7}
            className="min-h-36 resize-y font-mono text-xs"
            value={configuration.uploadedContent ?? ""}
            // i18n-ignore: sample CSV content, not interface copy
            placeholder={
              "title,subtitle,date\nBoard meeting,Room 204,2026-08-12"
            }
            disabled={readOnly}
            onChange={(event) => applyContent(event.target.value)}
          />
          <FieldDescription>{t("widgets.csv.paste.hint")}</FieldDescription>
        </Field>
      )}

      {mode === "paste" && inspection && configuration.uploaded && (
        <Alert role="status">
          <AlertTitle>
            {t("widgets.csv.paste.detected", {
              count: inspection.columns.length,
            })}
          </AlertTitle>
          <AlertDescription>
            {t("widgets.csv.paste.summary", {
              count: inspection.rowCount,
              columns: inspection.columns.join(", "),
            })}
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}
