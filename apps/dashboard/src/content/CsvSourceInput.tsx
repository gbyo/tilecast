import { ClipboardPaste, Link, RotateCcw, UploadCloud } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { StructuredSourceConfig } from "../api/types";
import { ToggleGroup } from "../components/ToggleGroup";
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
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const applyContent = (content: string) => {
    const inspection = inspectCsv(content);
    if (!content.trim()) {
      onChange({ url: "", uploadedContent: undefined, uploaded: false });
      setError("Choose a CSV file that contains a header row.");
      return;
    }
    if (inspection.columns.length < 1) {
      setError("Tilecast could not find any column names in the first row.");
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
      setError("Use a .csv, .tsv, or delimited .txt file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("This file is larger than the 2 MB upload limit.");
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
      setError(
        "This file is not valid UTF-8. Export it as UTF-8 CSV and retry.",
      );
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
      <legend>CSV connection</legend>
      <ToggleGroup
        className="csv-source-input__modes"
        label="CSV connection type"
        value={mode}
        onValueChange={switchMode}
        items={[
          {
            value: "upload",
            label: (
              <>
                <UploadCloud size={15} /> Upload
              </>
            ),
            disabled: readOnly,
          },
          {
            value: "url",
            label: (
              <>
                <Link size={15} /> Hosted URL
              </>
            ),
            disabled: readOnly,
          },
          {
            value: "paste",
            label: (
              <>
                <ClipboardPaste size={15} /> Paste data
              </>
            ),
            disabled: readOnly,
          },
        ]}
      />

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
            <strong>Drop a spreadsheet export here</strong>
            <small>
              or choose a CSV, TSV, or delimited text file up to 2 MB
            </small>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            Choose file
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
          <AlertTitle>{fileName || "CSV data ready"}</AlertTitle>
          <AlertDescription>
            {fileSize === undefined
              ? "Stored CSV data will remain attached unless you replace it"
              : `${formatBytes(fileSize)} · ${inspection?.rowCount ?? 0} data rows · ${inspection?.columns?.length ?? 0} columns`}
          </AlertDescription>
          {!readOnly && (
            <AlertAction>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Choose a different CSV file"
                aria-label="Choose a different CSV file"
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
          <FieldLabel htmlFor={urlId}>Direct CSV URL</FieldLabel>
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
          <FieldDescription>
            Tilecast refreshes a public HTTPS URL automatically. Use a direct
            CSV response, not a spreadsheet sharing page.
          </FieldDescription>
        </Field>
      )}

      {mode === "paste" && (
        <Field>
          <FieldLabel htmlFor={pasteId}>CSV data</FieldLabel>
          <Textarea
            id={pasteId}
            rows={7}
            value={configuration.uploadedContent ?? ""}
            placeholder={
              "title,subtitle,date\nBoard meeting,Room 204,2026-08-12"
            }
            disabled={readOnly}
            onChange={(event) => applyContent(event.target.value)}
          />
          <FieldDescription>
            Include column names in the first row. Comma, semicolon, tab, and
            pipe delimiters are supported.
          </FieldDescription>
        </Field>
      )}

      {mode === "paste" && inspection && configuration.uploaded && (
        <Alert role="status">
          <AlertTitle>{inspection.columns.length} columns detected</AlertTitle>
          <AlertDescription>
            {inspection.rowCount} data rows. Available columns:{" "}
            {inspection.columns.join(", ")}.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </fieldset>
  );
}
